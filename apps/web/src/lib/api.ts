import type {
  AddGroupAgent, AntigravityAuthState, AntigravityInstallState, Approval, AppSettings, Bootstrap, BrowserAction, BrowserConnect, BrowserDiscovery, BrowserSessionState, BrowserTab, CreateGroup, DirectoryListing, ExternalConversationDetails, ExternalConversationList, FileEntry, GitHubState, GitStatus, GroupSnapshot, ImportConversationResult, Project, ProjectContext, ProviderCatalog, ProviderInfo,
  RepositoryBranch, RepositoryCommit, RepositoryMutationResult, RepositoryPullRequest, RepositoryPush, RepositoryState, RunChanges, SendGroupMessage, Session, SessionUsage, ToolCall, Task, TaskStatus, WorkspaceEvent, Message, MessageContextRef, EditSessionPlan, SessionPlan, UserInputAnswers, UserQuestion,
} from '@mingle/contracts';
import type { AccountState, AccountConnection, AccountPreferences, SavedAccountPreferences, AttachmentRef, NativeActionCatalog } from '@mingle/contracts';
import type { ProjectCollaborationSnapshot, SendTeamChatMessage, TeamChatSnapshot, TeamChatMessage } from '@mingle/contracts';
import type { ProgressBoardResponse } from '@mingle/contracts';
import type {
  ContextCompactionResult as ContractContextCompactionResult,
  ProviderFailure as ContractProviderFailure,
  RecoveryActionRequest as ContractRecoveryActionRequest, RecoveryActionResult as ContractRecoveryActionResult,
  RecoveryCheckpoint, UpdateGroup,
} from '@mingle/contracts';
export type { ProviderCatalog } from '@mingle/contracts';
export type { AutonomyConfig, AutonomyMode, GroupRecoveryPolicy } from '@mingle/contracts';

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** Pulls a human readable message out of a failed response; the server contract is `{ error: string }`. */
async function readError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  if (text) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && 'error' in parsed && typeof (parsed as { error: unknown }).error === 'string') {
        return (parsed as { error: string }).error;
      }
    } catch {
      /* body was not JSON; fall through to raw text */
    }
    if (text.length < 300 && !text.trimStart().startsWith('<')) return text.trim();
  }
  if (res.status === 502 || res.status === 503 || res.status === 504) return 'The local runtime is not reachable. Restart Mingle or its development server.';
  return `Request failed with status ${res.status}`;
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError('Cannot reach the local runtime. Check that Mingle is still running.', 0);
  }
  if (!res.ok) throw new ApiError(await readError(res), res.status);
  return res;
}

async function json<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await request(path, {
    method,
    signal,
    headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

const q = (params: Record<string, string | number | null | undefined>): string => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
};

export interface NewSessionInput {
  projectId: string; name?: string; provider?: Session['provider']; model?: string;
  effort?: Session['effort']; policy?: Session['policy']; serviceTier?: string; isolated?: boolean;
}
export type SessionPatch = Partial<Pick<Session, 'name' | 'provider' | 'model' | 'effort' | 'policy' | 'serviceTier' | 'pinned' | 'unread'>>;
export type GroupPatch = UpdateGroup;
export type ApiProviderFailure = ContractProviderFailure;
export type ApiRecoveryCheckpoint = RecoveryCheckpoint;
export type ApiRecoveryActionRequest = ContractRecoveryActionRequest;
export type ApiRecoveryActionResult = ContractRecoveryActionResult;
export interface NewTaskInput {
  projectId: string; title: string; description: string; acceptanceCriteria: string; sessionId: string | null; dependsOn: string[];
}
export interface TaskPatch {
  title?: string; description?: string; acceptanceCriteria?: string; sessionId?: string | null; dependsOn?: string[]; status?: TaskStatus;
}
export interface HandoffInput {
  fromSessionId: string; toSessionId: string; taskId?: string; path: string; revision: string; note: string;
}
export type ContextCompactionResult = ContractContextCompactionResult;

export interface FileDoc { path: string; content: string }
/** The file endpoint is documented as `{content, path}`, but tolerate a raw text body as well. */
async function readFile(projectId: string, path: string, sessionId: string | null): Promise<FileDoc> {
  const res = await request(`/api/projects/${encodeURIComponent(projectId)}/file${q({ path, sessionId })}`);
  const text = await res.text();
  if ((res.headers.get('content-type') ?? '').includes('json')) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === 'object' && typeof (parsed as { content?: unknown }).content === 'string') {
        const doc = parsed as { content: string; path?: unknown };
        return { content: doc.content, path: typeof doc.path === 'string' ? doc.path : path };
      }
    } catch {
      /* raw body */
    }
  }
  return { content: text, path };
}

const projectBase = (projectId: string): string => `/api/projects/${encodeURIComponent(projectId)}`;
/** Mutation bodies never carry a session id the caller left unset; the server resolves the project folder instead. */
const withSession = <T extends object>(body: T, sessionId: string | null): T & { sessionId?: string } => (sessionId ? { ...body, sessionId } : body);

const groupBase = (groupId: string): string => `/api/groups/${encodeURIComponent(groupId)}`;
const browserBase = (sessionId: string): string => `/api/sessions/${encodeURIComponent(sessionId)}/browser`;
const dispatchLocalEvent = (name: string, detail: unknown): void => {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(name, { detail }));
};

export const api = {
  account: (signal?: AbortSignal) => json<AccountState>('/api/account', 'GET', undefined, signal),
  accountConnection: (connection: AccountConnection) => json<AccountState>('/api/account/connection', 'PUT', connection),
  accountSignIn: () => json<AccountState>('/api/account/sign-in', 'POST', {}),
  accountCancelSignIn: () => json<AccountState>('/api/account/sign-in', 'DELETE', {}),
  accountSignOut: () => json<AccountState>('/api/account/sign-out', 'POST', {}),
  accountStorageRetry: () => json<AccountState>('/api/account/storage/retry', 'POST', {}),
  accountPreferences: (signal?: AbortSignal) => json<SavedAccountPreferences | null>('/api/account/preferences', 'GET', undefined, signal),
  saveAccountPreferences: (preferences: AccountPreferences, expectedRevision: number | null) => json<SavedAccountPreferences>('/api/account/preferences', 'PUT', { preferences, expectedRevision }),
  bootstrap: (signal?: AbortSignal) => json<Bootstrap>('/api/bootstrap', 'GET', undefined, signal),
  createProject: (input: { name: string; path: string }) => json<Project>('/api/projects', 'POST', input),
  directories: (path: string, query: string, hidden: boolean, signal?: AbortSignal) =>
    json<DirectoryListing>(`/api/directories${q({ path: path || undefined, query: query || undefined, hidden: hidden ? 'true' : undefined })}`, 'GET', undefined, signal),
  revealDirectory: (path: string) => json<{ ok: boolean }>('/api/directories/reveal', 'POST', { path }),
  createProjectAt: (input: { name: string; parentPath: string }) => json<Project>('/api/projects/new', 'POST', input),
  cloneProject: (input: { url: string; name: string; parentPath: string }) => json<Project>('/api/projects/clone', 'POST', input),
  renameProject: (id: string, name: string) => json<Project>(`/api/projects/${encodeURIComponent(id)}`, 'PATCH', { name }),
  removeProject: (id: string) => json<{ ok: boolean; notices: string[] }>(`/api/projects/${encodeURIComponent(id)}`, 'DELETE'),
  projectCollaboration: (id: string, signal?: AbortSignal) => json<ProjectCollaborationSnapshot>(`${projectBase(id)}/collaboration`, 'GET', undefined, signal),
  projectTeamChat: (id: string, options: { limit?: number; before?: string } = {}, signal?: AbortSignal) =>
    json<TeamChatSnapshot>(`${projectBase(id)}/team-chat${q(options)}`, 'GET', undefined, signal),
  sendTeamChatMessage: (id: string, input: SendTeamChatMessage) => json<TeamChatMessage>(`${projectBase(id)}/team-chat/messages`, 'POST', input),
  importTeamChatHistory: (id: string, sessionId: string) => json<{ imported: number; messages: TeamChatMessage[]; truncated: boolean }>(`${projectBase(id)}/team-chat/import`, 'POST', { sessionId }),
  listFiles: (projectId: string, path: string, sessionId: string | null, signal?: AbortSignal) =>
    json<FileEntry[]>(`/api/projects/${encodeURIComponent(projectId)}/files${q({ path, sessionId })}`, 'GET', undefined, signal),
  searchFiles: (projectId: string, query: string, sessionId: string, signal?: AbortSignal) =>
    json<FileEntry[]>(`/api/projects/${encodeURIComponent(projectId)}/files/search${q({ query, sessionId })}`, 'GET', undefined, signal),
  readFile,
  writeFile: (projectId: string, path: string, content: string, sessionId: string | null) =>
    json<unknown>(`/api/projects/${encodeURIComponent(projectId)}/file${q({ path, sessionId })}`, 'PUT', { content }),
  git: (projectId: string, sessionId: string | null) =>
    json<GitStatus>(`/api/projects/${encodeURIComponent(projectId)}/git${q({ sessionId })}`),
  repository: (projectId: string, sessionId: string | null, signal?: AbortSignal) =>
    json<RepositoryState>(`${projectBase(projectId)}/repository${q({ sessionId })}`, 'GET', undefined, signal),
  github: (projectId: string, sessionId: string | null, refresh = false, signal?: AbortSignal) =>
    json<GitHubState>(`${projectBase(projectId)}/github${q({ sessionId, refresh: refresh ? 'true' : undefined })}`, 'GET', undefined, signal),
  repositoryCommit: (projectId: string, sessionId: string | null, input: Omit<RepositoryCommit, 'sessionId'>) =>
    json<RepositoryMutationResult>(`${projectBase(projectId)}/repository/commit`, 'POST', withSession(input, sessionId)),
  repositoryPush: (projectId: string, sessionId: string | null, input: Omit<RepositoryPush, 'sessionId'>) =>
    json<RepositoryMutationResult>(`${projectBase(projectId)}/repository/push`, 'POST', withSession(input, sessionId)),
  repositoryBranch: (projectId: string, sessionId: string | null, input: Omit<RepositoryBranch, 'sessionId'>) =>
    json<RepositoryMutationResult>(`${projectBase(projectId)}/repository/branch`, 'POST', withSession(input, sessionId)),
  repositoryPullRequest: (projectId: string, sessionId: string | null, input: Omit<RepositoryPullRequest, 'sessionId'>) =>
    json<RepositoryMutationResult>(`${projectBase(projectId)}/repository/pull-request`, 'POST', withSession(input, sessionId)),
  projectContext: (projectId: string, signal?: AbortSignal) => json<ProjectContext>(`${projectBase(projectId)}/context`, 'GET', undefined, signal),
  refreshProjectContext: (projectId: string) => json<ProjectContext>(`${projectBase(projectId)}/context/refresh`, 'POST', {}),
  createSession: (input: NewSessionInput) => json<Session>('/api/sessions', 'POST', input),
  updateSession: (id: string, patch: SessionPatch) => json<Session>(`/api/sessions/${encodeURIComponent(id)}`, 'PATCH', patch),
  createGroup: (input: CreateGroup) => json<GroupSnapshot>('/api/groups', 'POST', input),
  group: (id: string, signal?: AbortSignal) => json<GroupSnapshot>(groupBase(id), 'GET', undefined, signal),
  groupBoard: (id: string, projectId: string, signal?: AbortSignal) =>
    json<ProgressBoardResponse>(`${groupBase(id)}/board${q({ projectId })}`, 'GET', undefined, signal),
  updateGroup: (id: string, patch: GroupPatch) => json<GroupSnapshot>(groupBase(id), 'PATCH', patch),
  deleteGroup: (id: string) => json<{ ok: boolean; sessionIds: string[]; notices: string[] }>(groupBase(id), 'DELETE'),
  recoverGroup: (id: string, action: ApiRecoveryActionRequest) => json<ApiRecoveryActionResult>(`${groupBase(id)}/recovery`, 'POST', action),
  addGroupAgent: (id: string, input: AddGroupAgent) => json<GroupSnapshot>(`${groupBase(id)}/agents`, 'POST', input),
  removeGroupMember: (id: string, memberId: string) => json<GroupSnapshot>(`${groupBase(id)}/members/${encodeURIComponent(memberId)}`, 'DELETE'),
  sendGroupMessage: async (id: string, input: SendGroupMessage) => {
    const message: import('@mingle/contracts').GroupMessage = {
      id: `optimistic:${input.clientMessageId ?? crypto.randomUUID()}`, seq: Date.now(), groupId: id, senderMemberId: null,
      recipientMemberIds: input.recipients ?? [], kind: 'user', content: input.content,
      requestId: null, replyToId: null, sourceMessageId: null, sourceRunId: null, createdAt: new Date().toISOString(),
      ...(input.contextRefs?.length ? { contextRefs: input.contextRefs } : {}),
    };
    dispatchLocalEvent('mingle:optimistic-group-message', { groupId: id, message });
    try {
      const snapshot = await json<GroupSnapshot>(`${groupBase(id)}/messages`, 'POST', input);
      dispatchLocalEvent('mingle:optimistic-group-accepted', { snapshot });
      return snapshot;
    } catch (error) {
      dispatchLocalEvent('mingle:optimistic-group-remove', { groupId: id, messageId: message.id });
      throw error;
    }
  },
  groupActionCatalog: (id: string, memberId: string, signal?: AbortSignal, refresh = false) => json<NativeActionCatalog>(`${groupBase(id)}/members/${encodeURIComponent(memberId)}/catalog${refresh ? '?refresh=true' : ''}`, 'GET', undefined, signal),
  stopGroup: (id: string) => json<GroupSnapshot>(`${groupBase(id)}/stop`, 'POST', {}),
  resumeGroupMember: (id: string, memberId: string) => json<GroupSnapshot>(`${groupBase(id)}/members/${encodeURIComponent(memberId)}/resume`, 'POST', {}),
  pauseGroup: (id: string) => json<GroupSnapshot>(`${groupBase(id)}/pause`, 'POST', {}),
  resumeGroup: (id: string) => json<GroupSnapshot>(`${groupBase(id)}/resume`, 'POST', {}),
  interruptGroupMember: (id: string, memberId: string) => json<GroupSnapshot>(`${groupBase(id)}/members/${encodeURIComponent(memberId)}/interrupt`, 'POST', {}),
  runTools: (id: string) => json<ToolCall[]>(`/api/runs/${encodeURIComponent(id)}/tools`),
  runChanges: (id: string, signal?: AbortSignal) => json<RunChanges>(`/api/runs/${encodeURIComponent(id)}/changes`, 'GET', undefined, signal),
  toolCall: (id: string) => json<ToolCall>(`/api/tool-calls/${encodeURIComponent(id)}`),
  renameSession: (id: string, name: string) => json<Session>(`/api/sessions/${encodeURIComponent(id)}`, 'PATCH', { name }),
  deleteSession: (id: string) => json<{ ok: boolean; notices?: string[] }>(`/api/sessions/${encodeURIComponent(id)}`, 'DELETE'),
  sendMessage: async (id: string, content: string, skills?: string[], attachmentIds?: string[], contextRefs?: MessageContextRef[], intent: 'normal' | 'plan' = 'normal') => {
    const message: Message = {
      id: `optimistic:${crypto.randomUUID()}`, sessionId: id, role: 'user', content, createdAt: new Date().toISOString(),
      ...(contextRefs?.length ? { contextRefs } : {}),
    };
    dispatchLocalEvent('mingle:optimistic-session-message', { message });
    try {
      return await json<{ accepted: boolean }>(`/api/sessions/${encodeURIComponent(id)}/messages`, 'POST', {
        content, intent, ...(skills?.length ? { skills } : {}), ...(attachmentIds?.length ? { attachmentIds } : {}), ...(contextRefs?.length ? { contextRefs } : {}),
      });
    } catch (error) {
      dispatchLocalEvent('mingle:optimistic-session-remove', { messageId: message.id });
      throw error;
    }
  },
  editPlan: (id: string, input: EditSessionPlan) => json<SessionPlan>(`/api/plans/${encodeURIComponent(id)}`, 'PATCH', input),
  approvePlan: (id: string, revision: number) => json<SessionPlan>(`/api/plans/${encodeURIComponent(id)}/approve`, 'POST', { revision }),
  executePlan: (id: string) => json<{ accepted: true; runId: string | null; deliveryId?: string; plan: SessionPlan }>(`/api/plans/${encodeURIComponent(id)}/execute`, 'POST', {}),
  answerQuestion: (id: string, answers: UserInputAnswers) => json<UserQuestion>(`/api/questions/${encodeURIComponent(id)}/answer`, 'POST', answers),
  cancelQuestion: (id: string) => json<UserQuestion>(`/api/questions/${encodeURIComponent(id)}/cancel`, 'POST', {}),
  compactSession: (id: string, signal?: AbortSignal, operationId?: string) => json<ContextCompactionResult>(`/api/sessions/${encodeURIComponent(id)}/compact`, 'POST', operationId ? { operationId } : {}, signal),
  interruptCompaction: (id: string, operationId: string) => json<{ interrupted: boolean }>(`/api/sessions/${encodeURIComponent(id)}/compact/interrupt`, 'POST', { operationId }),
  sessionRecovery: (id: string, signal?: AbortSignal) => json<{ checkpoint: ApiRecoveryCheckpoint | null; failure: ApiProviderFailure | null }>(`/api/sessions/${encodeURIComponent(id)}/recovery`, 'GET', undefined, signal),
  createCheckpoint: (id: string, reason: string, runId?: string) => json<ApiRecoveryCheckpoint>(`/api/sessions/${encodeURIComponent(id)}/checkpoints`, 'POST', { reason, ...(runId ? { runId } : {}) }),
  attachmentDrafts: (scope: { kind: 'session' | 'group'; id: string }, signal?: AbortSignal) => json<AttachmentRef[]>(`/api/${scope.kind === 'session' ? 'sessions' : 'groups'}/${encodeURIComponent(scope.id)}/attachments`, 'GET', undefined, signal),
  uploadAttachment: async (scope: { kind: 'session' | 'group'; id: string }, file: File, signal?: AbortSignal): Promise<AttachmentRef> => {
    const url = `/api/${scope.kind === 'session' ? 'sessions' : 'groups'}/${encodeURIComponent(scope.id)}/attachments?name=${encodeURIComponent(file.name)}`;
    const res = await request(url, { method: 'POST', signal, headers: { 'content-type': file.type || 'application/octet-stream', accept: 'application/json' }, body: file });
    return await res.json() as AttachmentRef;
  },
  removeAttachment: (id: string) => json<{ ok: boolean }>(`/api/attachments/${encodeURIComponent(id)}`, 'DELETE'),
  attachmentUrl: (id: string) => `/api/attachments/${encodeURIComponent(id)}/content`,
  sessionCatalog: (id: string, signal?: AbortSignal, refresh = false) => json<ProviderCatalog>(`/api/sessions/${encodeURIComponent(id)}/catalog${refresh ? '?refresh=true' : ''}`, 'GET', undefined, signal),
  sessionUsage: (id: string, refresh = false, signal?: AbortSignal) => json<SessionUsage>(`/api/sessions/${encodeURIComponent(id)}/usage${refresh ? '?refresh=true' : ''}`, 'GET', undefined, signal),
  imports: (provider: Session['provider'], projectId?: string, cursor?: string, signal?: AbortSignal) =>
    json<ExternalConversationList>(`/api/imports${q({ provider, projectId, cursor })}`, 'GET', undefined, signal),
  importDetails: (provider: Session['provider'], conversationId: string, signal?: AbortSignal) =>
    json<ExternalConversationDetails>(`/api/imports/${encodeURIComponent(provider)}/${encodeURIComponent(conversationId)}`, 'GET', undefined, signal),
  importConversation: (provider: Session['provider'], conversationId: string) =>
    json<ImportConversationResult>('/api/imports', 'POST', { provider, conversationId }),
  interrupt: (id: string) => json<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(id)}/interrupt`, 'POST'),
  createTask: (input: NewTaskInput) => json<Task>('/api/tasks', 'POST', input),
  updateTask: (id: string, patch: TaskPatch) => json<Task>(`/api/tasks/${encodeURIComponent(id)}`, 'PATCH', patch),
  runTask: (id: string) => json<{ accepted: boolean }>(`/api/tasks/${encodeURIComponent(id)}/run`, 'POST'),
  handoff: (input: HandoffInput) => json<WorkspaceEvent>('/api/handoffs', 'POST', input),
  decideApproval: (id: string, decision: 'approved' | 'denied') => json<Approval>(`/api/approvals/${encodeURIComponent(id)}`, 'POST', { decision }),
  updateSettings: (patch: Partial<AppSettings>) => json<AppSettings>('/api/settings', 'PATCH', patch),
  refreshProviders: () => json<ProviderInfo[]>('/api/providers/refresh', 'POST'),
  antigravityInstallState: (signal?: AbortSignal) => json<AntigravityInstallState>('/api/providers/antigravity/install', 'GET', undefined, signal),
  installAntigravityRuntime: () => json<AntigravityInstallState>('/api/providers/antigravity/install', 'POST', {}),
  antigravityAuthState: (signal?: AbortSignal) => json<AntigravityAuthState>('/api/providers/antigravity/auth', 'GET', undefined, signal),
  startAntigravityAuth: (refresh = false) => json<AntigravityAuthState>('/api/providers/antigravity/auth', 'POST', { refresh }),
  cancelAntigravityAuth: () => json<AntigravityAuthState>('/api/providers/antigravity/auth', 'DELETE', {}),
  browserDiscovery: (signal?: AbortSignal) => json<BrowserDiscovery>('/api/browser/discovery', 'GET', undefined, signal),
  /** Downloads the managed Chromium; can take up to about two minutes. */
  installBrowser: () => json<BrowserDiscovery>('/api/browser/install', 'POST', {}),
  browserState: (sessionId: string, signal?: AbortSignal) => json<BrowserSessionState>(`${browserBase(sessionId)}`, 'GET', undefined, signal),
  browserConnect: (sessionId: string, input: BrowserConnect) => json<BrowserSessionState>(`${browserBase(sessionId)}/connect`, 'POST', input),
  browserDisconnect: (sessionId: string) => json<BrowserSessionState>(`${browserBase(sessionId)}/disconnect`, 'POST', {}),
  browserNewTab: (sessionId: string, url?: string) => json<BrowserTab>(`${browserBase(sessionId)}/tabs`, 'POST', url ? { url } : {}),
  /** `clientId` is the viewer id from the stream's hello message; the server checks it against the tab's control owner. */
  browserAction: (sessionId: string, tabId: string, action: BrowserAction, clientId?: string) =>
    json<unknown>(`${browserBase(sessionId)}/tabs/${encodeURIComponent(tabId)}/action`, 'POST', clientId ? { action, clientId } : { action }),
};

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
