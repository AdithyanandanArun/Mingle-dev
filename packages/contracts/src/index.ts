import { z } from 'zod';
import { GroupDefaultsSchema } from './groups';
import { AttachmentIdsSchema } from './attachments';
import { MessageContextRefsSchema } from './message-context';

import { ProviderSchema, PolicySchema, EffortSchema, ServiceTierSchema } from './provider-config';
import type { Provider, Policy, Effort } from './provider-config';
import type { ContextCompactionResult } from './resilience';
export * from './provider-config';
export type SessionStatus = 'idle' | 'running' | 'waiting' | 'interrupted' | 'error';
export type TaskStatus = 'backlog' | 'ready' | 'running' | 'blocked' | 'review' | 'done';
export interface Project { id: string; name: string; path: string; createdAt: string; isExample: boolean }
export interface Session {
  id: string; projectId: string; name: string; provider: Provider; model: string; effort: Effort;
  status: SessionStatus; policy: Policy; serviceTier?: string; isolated: boolean; worktreePath: string; branch: string | null;
  providerSessionId: string | null; createdAt: string; updatedAt: string; error: string | null;
  inputTokens: number; outputTokens: number; costUsd: number | null;
  pinned: boolean; unread: boolean;
}
export type RunStatus = 'running' | 'completed' | 'failed' | 'interrupted';
export type ToolCategory = 'command' | 'browser' | 'search' | 'file' | 'agent' | 'other';
export type ToolStatus = 'running' | 'completed' | 'failed' | 'interrupted';
export interface SessionRun {
  id: string; sessionId: string; userMessageId: string; provider: Provider; model: string;
  status: RunStatus; startedAt: string; finishedAt: string | null; durationMs: number | null;
  toolCount: number; toolCounts: Partial<Record<ToolCategory, number>>;
  changes?: RunChangesSummary | null;
}
export interface RunChangedFile {
  path: string; status: 'A' | 'M' | 'D' | 'T'; additions: number | null; deletions: number | null; binary: boolean;
}
/** Saved net workspace edits between this run's start and end; unknown historical runs have no summary. */
export interface RunChangesSummary {
  status: 'available' | 'unavailable'; capturedAt: string;
  fileCount: number; files: RunChangedFile[]; additions: number; deletions: number;
  truncated: boolean; notices: string[];
}
export interface RunChanges { summary: RunChangesSummary; diff: string; diffTruncated: boolean }
/** One provider tool invocation, updated throughout its lifecycle rather than duplicated for start/result. */
export interface ToolCall {
  id: string; runId: string; sessionId: string; providerId: string; parentProviderId: string | null;
  name: string; category: ToolCategory; status: ToolStatus; summary: string; command: string | null;
  input: string; output: string; outputTruncated?: boolean; cwd: string | null; exitCode: number | null; processId: string | null;
  startedAt: string; finishedAt: string | null; durationMs: number | null;
}
/** Provider-supplied fields; host assigns durable IDs and timestamps. Missing fields retain their previous value. */
export interface ToolActivity {
  id: string; name: string; category: ToolCategory; status: ToolStatus;
  parentId?: string | null; summary?: string; command?: string | null; input?: string; output?: string;
  cwd?: string | null; exitCode?: number | null; processId?: string | null; durationMs?: number | null;
}
export interface Message { id: string; sessionId: string; role: 'user' | 'assistant' | 'system' | 'tool'; content: string; createdAt: string; kind?: string; runId?: string; attachments?: import('./attachments').AttachmentRef[]; contextRefs?: import('./message-context').MessageContextRef[] }
export interface Task { id: string; projectId: string; title: string; description: string; acceptanceCriteria: string; sessionId: string | null; dependsOn: string[]; status: TaskStatus; createdAt: string; updatedAt: string; source?: import('./project-context').TaskSource }
export interface WorkspaceEvent { id: number; projectId: string | null; sessionId: string | null; type: string; summary: string; payload: Record<string, unknown>; createdAt: string }
export interface Approval { id: string; sessionId: string; tool: string; description: string; input: Record<string, unknown>; status: 'pending' | 'approved' | 'denied'; createdAt: string }
export interface ProviderModel {
  id: string; name: string;
  aliases?: string[];
  reasoningEfforts?: { id: string; label: string; description?: string }[];
  defaultReasoningEffort?: string;
  serviceTiers?: { id: string; name: string; description?: string }[];
  defaultServiceTier?: string;
  policies?: Policy[];
  /** Native input modalities when the provider reports them per model (for example `text`, `image`). Absent means unreported. */
  inputModalities?: string[];
}
export interface ProviderInfo {
  id: Provider; name: string; available: boolean; version: string | null; executable: string | null; reason: string | null; models: ProviderModel[]; policies?: Policy[];
  /** Native input transport capabilities; ACP values are negotiated during discovery and SDK values describe its supported content API. A model modality, when reported, takes precedence. */
  promptCapabilities?: { image: boolean; embeddedContext: boolean };
}
/** Installation is explicit and separate from provider authentication and model execution. */
export interface AntigravityInstallState {
  supported: boolean; version: string;
  state: 'not-installed' | 'installing' | 'installed' | 'error';
  executable: string | null; error: string | null;
}
export interface AntigravityAuthState {
  state: 'idle' | 'authenticating' | 'authenticated' | 'error'; error: string | null;
  phase?: 'starting' | 'waiting-for-browser' | 'loading-models';
  /** Native Google login URL, held only in memory while browser authentication is pending. */
  authorizationUrl?: string;
  browserError?: string;
}
export interface ProviderCommand {
  id: string; name: string; description: string; argumentHint?: string;
  /** `relay` is retained only to read catalog provenance stored before the Mingle rename. */
  source: 'provider' | 'project' | 'user' | 'relay'; kind: 'prompt' | 'action';
}
export interface ProviderSkill {
  id: string; name: string; description: string; path?: string;
  source: 'provider' | 'project' | 'user'; enabled: boolean;
}
export interface ProviderCatalog { commands: ProviderCommand[]; skills: ProviderSkill[]; warnings: string[] }
export interface UsageWindow {
  id: string; label: string; scope?: string;
  usedPercent: number | null; remainingPercent: number | null;
  resetAt: string | null; windowMinutes: number | null;
}
export interface UsageCredits {
  balance: string | null; unit: string | null; unlimited: boolean | null; resetAt: string | null;
}
export interface UsageResetGrant {
  id: string; label: string; expiresAt: string | null; grantedAt: string | null;
}
export interface ProviderUsage {
  provider: Provider; fetchedAt: string; status: 'available' | 'partial' | 'unavailable'; plan: string | null;
  windows: UsageWindow[]; credits: UsageCredits | null;
  resets: { available: number | null; grants: UsageResetGrant[]; detailsKnown: boolean; replenishesAt: string | null } | null;
  notices: string[];
}
export interface SessionUsage extends ProviderUsage {
  session: { id: string; inputTokens: number; outputTokens: number; costUsd: number | null };
}
/** Local provider history metadata. Native IDs are resolved again before import. */
export interface ExternalConversation {
  provider: Provider; id: string; title: string; directory: string | null;
  updatedAt: string | null; createdAt: string | null; model: string | null;
  importedSessionId?: string; unavailableReason?: string;
}
export interface ExternalConversationList { conversations: ExternalConversation[]; nextCursor: string | null; notices: string[] }
export interface ExternalConversationMessage { role: Message['role']; content: string; createdAt: string | null }
export interface ExternalConversationDetails {
  conversation: ExternalConversation; messages: ExternalConversationMessage[]; truncated: boolean; notices: string[];
}
export interface ImportConversationResult { session: Session; project: Project; alreadyImported: boolean; notices: string[] }
export interface ConversationListOptions { directory?: string; cursor?: string }
export const ConversationIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
export const ImportConversationSchema = z.object({ provider: ProviderSchema, conversationId: ConversationIdSchema }).strict();
export interface AppSettings {
  defaultProvider: Provider; defaultCodexModel: string; defaultClaudeModel: string; defaultEffort: Effort; defaultIsolated: boolean;
  defaultAntigravityModel?: string; defaultOpencodeModel?: string;
  defaultPolicy: Policy; defaultServiceTier?: string; theme: 'dark' | 'light'; claudeExecutable: string; codexExecutable: string;
  antigravityExecutable?: string; opencodeExecutable?: string;
  groupDefaults?: import('./groups').GroupDefaults;
  autoCompactPercent?: number | null;
  onboardingCompletedVersion?: number;
  browserAgentEnabled?: boolean; browserExecutable?: string;
  browserDefaultMode?: 'managed' | 'existing'; browserExistingSourceId?: string; browserCdpEndpoint?: string;
}
export interface Bootstrap { projects: Project[]; sessions: Session[]; messages: Message[]; tasks: Task[]; events: WorkspaceEvent[]; approvals: Approval[]; plans: import('./planning').SessionPlan[]; questions: import('./planning').UserQuestion[]; providers: ProviderInfo[]; settings: AppSettings; version: string; runs: SessionRun[]; toolCalls: ToolCall[]; groups?: import('./groups').GroupSnapshot[] }
export interface GitFile { path: string; status: string }
export interface GitStatus { branch: string; files: GitFile[]; diff: string; isRepo: boolean }
export interface FileEntry { path: string; name: string; type: 'file' | 'directory' }
export interface LocalDirectory { name: string; path: string; symlink: boolean }
export interface DirectoryListing {
  path: string; displayPath: string; parentPath: string | null; homePath: string;
  separator: string; platform: string; directories: LocalDirectory[];
  roots: { name: string; path: string }[]; canSelect: boolean; canCreateWithin?: boolean; truncated: boolean;
}
export const NewProjectSchema = z.object({
  name: z.string().trim().min(1).max(100), parentPath: z.string().min(1).max(4096),
}).strict();
export const CloneProjectSchema = z.object({
  url: z.string().trim().min(1).max(2048), name: z.string().trim().min(1).max(100), parentPath: z.string().min(1).max(4096),
}).strict();
export type ServerEvent =
  | { type: 'state.changed'; event?: WorkspaceEvent }
  | { type: 'browser.opened'; sessionId: string; tabId: string }
  | { type: 'session.delta'; sessionId: string; messageId: string; delta: string; offset?: number }
  | { type: 'terminal.ready'; terminalId: string }
  | { type: 'terminal.error'; message: string }
  | { type: 'terminal.output'; terminalId: string; data: string }
  | { type: 'terminal.exit'; terminalId: string; exitCode: number };
export type ClientEvent =
  | { type: 'terminal.start'; projectId: string; sessionId?: string; cols: number; rows: number }
  | { type: 'terminal.input'; terminalId: string; data: string }
  | { type: 'terminal.resize'; terminalId: string; cols: number; rows: number }
  | { type: 'terminal.stop'; terminalId: string };

export const CreateProjectSchema = z.object({ name: z.string().trim().min(1).max(100), path: z.string().min(1).max(4096) });
export const UpdateProjectSchema = z.object({ name: z.string().trim().min(1).max(100) }).strict();
export const CreateSessionSchema = z.object({
  projectId: z.string().min(1), name: z.string().trim().min(1).max(100).optional(), provider: ProviderSchema.optional(),
  model: z.string().trim().min(1).max(150).optional(), effort: EffortSchema.optional(),
  policy: PolicySchema.optional(), serviceTier: ServiceTierSchema.optional(), isolated: z.boolean().optional(),
});
export const UpdateSessionSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(), provider: ProviderSchema.optional(),
  model: z.string().trim().min(1).max(150).optional(), effort: EffortSchema.optional(), policy: PolicySchema.optional(), serviceTier: ServiceTierSchema.optional(),
  pinned: z.boolean().optional(), unread: z.boolean().optional(),
}).strict().refine((patch) => Object.keys(patch).length > 0, 'Supply a session setting to update');
export const SendMessageSchema = z.object({
  content: z.string().trim().max(100_000).default(''), intent: z.enum(['normal', 'plan']).default('normal'), skills: z.array(z.string().min(1).max(4096)).max(20).optional(),
  attachmentIds: AttachmentIdsSchema.optional(),
  contextRefs: MessageContextRefsSchema.optional(),
}).strict().refine((body) => body.content.length > 0 || (body.attachmentIds?.length ?? 0) > 0, { message: 'Write a message or attach a file', path: ['content'] });
export const CreateTaskSchema = z.object({ projectId: z.string().min(1), title: z.string().trim().min(1).max(200), description: z.string().max(20_000).default(''), acceptanceCriteria: z.string().max(10_000).default(''), sessionId: z.string().nullable().default(null), dependsOn: z.array(z.string()).max(100).default([]) });
export const UpdateTaskSchema = z.object({ title: z.string().trim().min(1).max(200).optional(), description: z.string().max(20_000).optional(), acceptanceCriteria: z.string().max(10_000).optional(), sessionId: z.string().nullable().optional(), dependsOn: z.array(z.string()).max(100).optional(), status: z.enum(['backlog', 'ready', 'running', 'blocked', 'review', 'done']).optional() });
export const HandoffSchema = z.object({ fromSessionId: z.string().min(1), toSessionId: z.string().min(1), taskId: z.string().optional(), path: z.string().min(1).max(4096), revision: z.string().trim().min(1).max(100), note: z.string().max(10_000).default('') });
export const UpdateSettingsSchema = z.object({
  defaultProvider: ProviderSchema.optional(), defaultCodexModel: z.string().trim().min(1).max(150).optional(),
  defaultClaudeModel: z.string().trim().min(1).max(150).optional(), defaultEffort: EffortSchema.optional(),
  defaultAntigravityModel: z.string().trim().min(1).max(150).optional(), defaultOpencodeModel: z.string().trim().min(1).max(150).optional(),
  defaultIsolated: z.boolean().optional(),
  defaultPolicy: PolicySchema.optional(), defaultServiceTier: ServiceTierSchema.optional(), theme: z.enum(['dark', 'light']).optional(),
  claudeExecutable: z.string().max(4096).optional(), codexExecutable: z.string().max(4096).optional(),
  antigravityExecutable: z.string().max(4096).optional(), opencodeExecutable: z.string().max(4096).optional(),
  groupDefaults: z.lazy(() => GroupDefaultsSchema).optional(),
  autoCompactPercent: z.number().int().min(1).max(95).nullable().optional(),
  onboardingCompletedVersion: z.number().int().min(1).max(1).optional(),
  browserAgentEnabled: z.boolean().optional(), browserExecutable: z.string().max(4096).optional(),
  browserDefaultMode: z.enum(['managed', 'existing']).optional(), browserExistingSourceId: z.string().max(200).optional(),
  browserCdpEndpoint: z.string().max(2048).optional(),
});
export const ApprovalDecisionSchema = z.object({ decision: z.enum(['approved', 'denied']) });

// Provider boundary: implemented independently from persistence and transport.
export interface RunOptions {
  /** Attachments staged privately for this run only. Adapters send images natively and reference other files by path. */
  attachments?: import('./attachments').RunAttachment[];
  /**
   * An explicit native command or skill. `prompt` is then the exact provider-native user text (leading `/command` or `$skill`);
   * `context` carries team instructions that must travel through the provider's own context mechanism instead of the text.
   */
  invocation?: import('./attachments').NativeInvocation;
  context?: string;
  /** Native read-only planning intent; adapters must reject it unless the runtime provides a real plan mode. */
  intent?: 'normal' | 'plan';
  teamMcp?: import('./groups').TeamMcpConnection; providerTaskState?: import('./project-context').ProviderTaskPlan['steps']; session: Session; prompt: string; skills?: ProviderSkill[]; browserMcp?: import('./browser').BrowserMcpConnection; signal: AbortSignal; onEvent: (event: AdapterEvent) => void; requestApproval: (request: { tool: string; description: string; input: Record<string, unknown> }) => Promise<boolean>; requestUserInput?: (request: import('./planning').NativeUserInputRequest) => Promise<import('./planning').UserInputAnswers | null>; settings: AppSettings }
export type AdapterEvent =
  | ({ type: 'task.plan' } & import('./project-context').ProviderTaskPlan)
  | ({ type: 'session.plan' } & import('./planning').SessionPlanProposal)
  | { type: 'session'; providerSessionId: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; content: string }
  | { type: 'tool.activity'; activity: ToolActivity }
  | { type: 'tool.output'; id: string; delta: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; costUsd: number | null }
  | { type: 'info'; content: string };
export interface AgentAdapter {
  run(options: RunOptions): Promise<void>;
  /** Explicit native context compaction, when supported; unsupported runtimes leave history untouched. */
  compact?(options: { session: Session; settings: AppSettings; signal: AbortSignal }): Promise<ContextCompactionResult>;
}

/**
 * Merge a text chunk at its absolute offset. A bootstrap snapshot may already contain some or all of it.
 * null means the client has a gap and must fetch a current snapshot rather than invent missing text.
 */
export { mergeTextDelta } from './stream';
export * from './browser';

export * from './repository';
export * from './project-context';

export * from './groups';
export * from './resilience';
export * from './attachments';
export * from './message-context';
export * from './native-actions';
export * from './account';
export * from './planning';
export * from './teams';
export * from './remote-execution';
export * from './remote-git';
export * from './devices';

export * from './project-collaboration';
export * from './team-chat';
export * from './team-orchestration';
