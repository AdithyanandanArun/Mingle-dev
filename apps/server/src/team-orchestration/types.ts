import type { AuthenticatedTransportMessage, TeamConsent, TeamStructurePayload, Session } from '@mingle/contracts';
import type { ProjectCollaborationSnapshot } from '../../../../packages/contracts/src/project-collaboration.ts';
import type { SessionRuntime, StartOptions } from '../runtime.ts';
import type { Store } from '../store.ts';
import type { DistributedWorkspaceService } from '../distributed/service.ts';

export interface TeamRouteContext {
  req: import('node:http').IncomingMessage;
  res: import('node:http').ServerResponse;
  url: URL;
  params: Record<string, string>;
  body<T>(schema: import('zod').ZodType<T>): Promise<T>;
}
export type TeamRouteAdder = (method: string, pattern: string, handler: (ctx: TeamRouteContext) => Promise<unknown> | unknown) => void;

export interface TeamOrchestrationDeviceSide {
  routes(add: TeamRouteAdder): void;
  close(): Promise<void>;
  latestStructure(sharedProjectId: string): TeamStructurePayload | null;
  localConsent(sharedProjectId: string): TeamConsent | null;
}

export interface TeamOrchestrationDeviceDependencies {
  store: Store;
  runtime: SessionRuntime;
  hub: import('../hub.ts').Hub;
  transport: TeamOrchestrationTransport;
  account: TeamOrchestrationAccount;
  distributed: DistributedWorkspaceService;
  collaboration: TeamOrchestrationCollaboration;
  teamChat: TeamOrchestrationChat;
  changed(): void;
}
export type TeamOrchestrationDeviceSideFactory = (dependencies: TeamOrchestrationDeviceDependencies) => TeamOrchestrationDeviceSide;

export interface TeamOrchestrationTransport {
  snapshot(teamId?: string): import('@mingle/contracts').TransportSnapshot;
  send(input: { teamId: string; toDeviceId: string; kind: string; payload: unknown; idempotencyKey: string }): Promise<unknown>;
  onMessage(handler: (message: AuthenticatedTransportMessage) => void | Promise<void>): () => void;
  sync(): Promise<void>;
}

export interface TeamOrchestrationGroups {
  get(id: string): import('@mingle/contracts').GroupSnapshot;
  createTeamGroup(input: {
    id: string; projectId: string; title: string; orchestratorSessionId: string;
    members: Array<{ sessionId: string; handle: string; role: 'orchestrator' | 'worker' | 'idle'; held: boolean }>;
  }): import('@mingle/contracts').GroupSnapshot;
  syncTeamMembers(groupId: string, members: Array<{ sessionId: string; handle: string; role: 'orchestrator' | 'worker' | 'idle'; held: boolean }>): void;
  pumpTeamGroup(groupId: string): void;
  setTeamLeader(groupId: string, sessionId: string | null, options?: { paused?: boolean; pauseReason?: string | null }): void;
  pauseTeamGroup(groupId: string, reason: string): void;
  sendTeamMessage(groupId: string, input: { content: string; recipients?: string[]; clientMessageId: string }): string[];
  contextForRun(sessionId: string, runId: string): import('@mingle/contracts').GroupRunContext | undefined;
  onRunFinished(sessionId: string, runId: string, outcome: 'completed' | 'failed' | 'interrupted'): void;
  setTeamDispatchGuard(guard: (sessionId: string, groupId: string) => Promise<boolean>): void;
  setTeamRunFinishedHook(hook: (input: { sessionId: string; runId: string; outcome: 'completed' | 'failed' | 'interrupted'; groupId: string; deliveryId: string }) => void): void;
  holdTeamMember(sessionId: string, reason: string): void;
}

export interface TeamOrchestrationCollaboration {
  snapshot(projectId: string): Promise<ProjectCollaborationSnapshot>;
}

export interface TeamOrchestrationAccount {
  withAuthenticatedClient<T>(callback: (client: import('@supabase/supabase-js').SupabaseClient, user: import('@supabase/supabase-js').User) => Promise<T>): Promise<T>;
}

export interface TeamProxyStartInput {
  session: Session;
  runId: string;
  content: string;
  options: StartOptions;
  context?: import('@mingle/contracts').GroupRunContext;
  consumedHandoffs?: string[];
}

export interface TeamProxyRuntimeService {
  isProxySession(sessionId: string): boolean;
  isActive(sessionId: string): boolean;
  activeCount(): number;
  start(input: TeamProxyStartInput): void;
  interrupt(sessionId: string): boolean;
  authorizeApprovalDecision(approvalId: string): Promise<void>;
  decideApproval(approvalId: string, decision: 'approved' | 'denied'): import('@mingle/contracts').Approval | null;
}

export interface TeamMcpProxy {
  create(runId: string, session: Session, signal: AbortSignal, context: import('@mingle/contracts').GroupRunContext): import('@mingle/contracts').TeamMcpConnection;
  revoke(runId: string): void;
  callRemote(runId: string, sessionId: string, tool: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface TeamChatOrchestrationMessage {
  id: string;
  teamId: string;
  sharedProjectId: string;
  body: string;
  mentions: string[];
  author: { kind: 'human'; accountId: string; displayName: string } | { kind: 'agent'; agentId: string; ownerAccountId: string; agentName: string };
}

export interface TeamOrchestrationChat {
  setOrchestratedRunState(input: { messageId: string; state: 'running' | 'completed' | 'failed' }): Promise<void>;
  postOrchestratedAgentReply(input: { projectId: string; sourceMessageId: string; agentId: string; content: string }): Promise<void>;
  postOrchestrationStatus(input: { projectId: string; content: string }): Promise<void>;
}
