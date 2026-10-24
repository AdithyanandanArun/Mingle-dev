import { z } from 'zod';
import { ProviderSchema, EffortSchema } from './provider-config';
import { ProviderFailureSchema } from './resilience';

/**
 * Cross-device team orchestration. See docs/team-orchestration.md.
 *
 * One device (the team lead's, called the host) brokers all agent work for a shared project.
 * Agents stay on their owner's device and run there in sandboxed (isolated worktree, no push) sessions.
 * Owners consent once when joining; the consent covers a permission level and a set of their agents.
 */

const Id = z.string().trim().min(1).max(100);
const Uuid = z.string().uuid();
const IsoTime = z.string().datetime({ offset: true });

/** Group-wide permission level chosen by the team lead. Applies to every agent in the group. */
export const TeamPermissionLevelSchema = z.enum(['supervised', 'full-access']);
export type TeamPermissionLevel = z.infer<typeof TeamPermissionLevelSchema>;

/** Bump when the disclaimer text changes; old consents then require re-acceptance. */
export const TEAM_CONSENT_DISCLAIMER_VERSION = '2026-10-24.1';
export const TEAM_CONSENT_DISCLAIMER =
  'The team lead and admins of this project will have access to the agents you add. '
  + 'By joining, you give them sandboxed access to those agents: they can send your agents work, '
  + 'and that work runs on this device with your provider account, in an isolated copy of the repository, '
  + 'without pushing. You can pause your agents or leave the team at any time.';

export const TeamOrchestrationSettingsSchema = z.object({
  /** When on, untagged team-chat messages go to the orchestrator agent. When off, only @mentions start agents. */
  leaderOrchestration: z.boolean(),
  permissionLevel: TeamPermissionLevelSchema,
  /** Roster agent id of the current orchestrator; null when none is assigned (work pauses). */
  orchestratorAgentId: Id.nullable(),
  /** Ordered fallback leaders tried automatically when the orchestrator is quota-exhausted or offline. */
  fallbackAgentIds: z.array(Id).max(4),
  /** Monotonic; every change increments it. Consents and deliveries reference it. */
  version: z.number().int().min(1),
  updatedAt: IsoTime,
  updatedByAccountId: Uuid,
}).strict();
export type TeamOrchestrationSettings = z.infer<typeof TeamOrchestrationSettingsSchema>;

/** PATCH /api/projects/:projectId/team-orchestration (team lead/admin on the host device only). */
export const UpdateTeamOrchestrationSchema = z.object({
  leaderOrchestration: z.boolean().optional(),
  permissionLevel: TeamPermissionLevelSchema.optional(),
  fallbackAgentIds: z.array(Id).max(4).optional(),
  expectedVersion: z.number().int().min(1),
}).strict();
export type UpdateTeamOrchestration = z.infer<typeof UpdateTeamOrchestrationSchema>;

/** POST /api/projects/:projectId/team-orchestration/enable — turns a shared project into an orchestrated team project. */
export const EnableTeamOrchestrationSchema = z.object({
  leaderOrchestration: z.boolean(),
  permissionLevel: TeamPermissionLevelSchema,
  orchestratorAgentId: Id,
  fallbackAgentIds: z.array(Id).max(4).default([]),
}).strict();
export type EnableTeamOrchestration = z.infer<typeof EnableTeamOrchestrationSchema>;

export const TeamConsentStateSchema = z.enum(['granted', 'needs-reconsent', 'paused', 'revoked']);
export type TeamConsentState = z.infer<typeof TeamConsentStateSchema>;

/** POST /api/projects/:projectId/team-consent (on the agent owner's device). */
export const AcceptTeamConsentSchema = z.object({
  /** Local session ids of the owner's agents to contribute. */
  sessionIds: z.array(Id).min(1).max(8),
  permissionLevel: TeamPermissionLevelSchema,
  settingsVersion: z.number().int().min(1),
  disclaimerVersion: z.literal(TEAM_CONSENT_DISCLAIMER_VERSION),
}).strict();
export type AcceptTeamConsent = z.infer<typeof AcceptTeamConsentSchema>;

/** PATCH /api/projects/:projectId/team-consent — owner pauses/resumes or revokes their agents. */
export const UpdateTeamConsentSchema = z.object({ state: z.enum(['granted', 'paused', 'revoked']) }).strict();

export interface TeamConsent {
  teamId: string; sharedProjectId: string; accountId: string; deviceId: string;
  agentIds: string[]; permissionLevel: TeamPermissionLevel; settingsVersion: number;
  disclaimerVersion: string; state: TeamConsentState; acceptedAt: string; updatedAt: string;
}

export const TeamAgentRoleSchema = z.enum(['orchestrator', 'worker', 'idle']);
export type TeamAgentRole = z.infer<typeof TeamAgentRoleSchema>;

export const TeamAgentStateSchema = z.enum(['idle', 'queued', 'working', 'awaiting-approval', 'quota-exhausted', 'offline', 'paused', 'failed']);
export type TeamAgentState = z.infer<typeof TeamAgentStateSchema>;

export interface TeamStructureMember {
  /** Roster agent id (stable across devices). */
  agentId: string;
  name: string;
  /** @handle used in team chat and orchestration tools. Unique within the team project. */
  handle: string;
  ownerAccountId: string; ownerDisplayName: string;
  deviceId: string; deviceName: string;
  /** True when this agent runs on the device serving this snapshot. */
  local: boolean;
  /** Local session id; present only when local. */
  sessionId: string | null;
  provider: z.infer<typeof ProviderSchema>; model: string; effort: z.infer<typeof EffortSchema> | null;
  role: TeamAgentRole;
  /** 1-based position in the fallback list, or null. */
  fallbackRank: number | null;
  state: TeamAgentState;
  consent: TeamConsentState;
  /** Short human-readable description of the current assignment, if any. */
  currentTask: string | null;
  lastActivityAt: string | null;
  failure: z.infer<typeof ProviderFailureSchema> | null;
}

export interface TeamLeaderChange {
  id: string; at: string; fromAgentId: string | null; toAgentId: string | null;
  reason: 'manual' | 'fallback-quota' | 'fallback-offline' | 'restored' | 'removed';
  byAccountId: string | null;
}

/** GET /api/projects/:projectId/team-structure — served on every member device. */
export interface TeamStructureSnapshot {
  projectId: string; teamId: string; sharedProjectId: string;
  enabled: boolean;
  settings: TeamOrchestrationSettings | null;
  host: { deviceId: string; accountId: string; displayName: string; online: boolean; isThisDevice: boolean };
  /** True when the signed-in account is the team lead or an admin AND this device is the host. */
  canEdit: boolean;
  /** This device's own consent, if it has contributed agents. */
  myConsent: TeamConsent | null;
  members: TeamStructureMember[];
  leaderHistory: TeamLeaderChange[];
  /** When the orchestrator is unavailable and no fallback applied: a human must pick a new leader. */
  needsLeader: boolean;
  observedAt: string;
}

/** POST /api/projects/:projectId/team-structure/changes — host device, lead/admin only. Optimistic via expectedVersion. */
export const TeamStructureChangeSchema = z.discriminatedUnion('action', [
  /** Promote an agent (any device) to orchestrator. The previous orchestrator becomes `previousRole`. */
  z.object({ action: z.literal('set-orchestrator'), agentId: Id, previousRole: z.enum(['worker', 'idle']).default('worker'), expectedVersion: z.number().int().min(1) }).strict(),
  z.object({ action: z.literal('set-role'), agentId: Id, role: z.enum(['worker', 'idle']), expectedVersion: z.number().int().min(1) }).strict(),
  z.object({ action: z.literal('set-fallbacks'), agentIds: z.array(Id).max(4), expectedVersion: z.number().int().min(1) }).strict(),
  z.object({ action: z.literal('remove'), agentId: Id, expectedVersion: z.number().int().min(1) }).strict(),
]);
export type TeamStructureChange = z.infer<typeof TeamStructureChangeSchema>;

/** One entry of an agent's own conversation, shown when clicking the agent in the presence bubble. */
export const TeamAgentActivityEntrySchema = z.object({
  id: Id, runId: Id.nullable(), at: IsoTime,
  kind: z.enum(['request', 'assistant', 'tool', 'status', 'approval', 'artifact', 'error']),
  /** Scrubbed, bounded text. Tool entries carry a one-line summary, never raw tool output. */
  text: z.string().max(8_000),
  toolName: z.string().max(120).optional(),
  status: z.string().max(40).optional(),
}).strict();
export type TeamAgentActivityEntry = z.infer<typeof TeamAgentActivityEntrySchema>;

/** GET /api/projects/:projectId/team-agents/:agentId/activity?before=cursor */
export interface TeamAgentActivity {
  agentId: string; local: boolean; state: TeamAgentState; runId: string | null;
  entries: TeamAgentActivityEntry[]; nextCursor: string | null;
  /** For remote agents: when the last mirrored update arrived. */
  mirroredAt: string | null;
}

/* ------------------------------------------------------------------------------------------ */
/* Device-to-device payloads. Kinds use the `teamgroup.` transport namespace. Peers are untrusted:
 * receivers must re-validate with these schemas and check team membership, roles and consent.   */

export const TEAM_GROUP_KINDS = {
  /** host → all member devices: authoritative settings + structure. */
  structure: 'teamgroup.structure',
  /** owner → host: consent granted/paused/revoked for a set of agents. */
  consent: 'teamgroup.consent',
  /** host → owner device: run this agent for this group delivery. */
  delivery: 'teamgroup.delivery',
  /** host → owner device: interrupt a delivery. */
  interrupt: 'teamgroup.interrupt',
  /** owner → host: delivery lifecycle + final result. */
  deliveryStatus: 'teamgroup.delivery.status',
  /** owner → host: a team tool call (assign/message/artifact/status) made by a remote agent run. */
  toolCall: 'teamgroup.tool.call',
  /** host → owner: result of that tool call. */
  toolResult: 'teamgroup.tool.result',
  /** owner → all member devices: bounded activity entries for the agent's own conversation view. */
  activity: 'teamgroup.activity',
  /** owner → host: an approval request from a supervised remote run. */
  approvalRequest: 'teamgroup.approval.request',
  /** host → owner: lead/admin decision on that approval. */
  approvalDecision: 'teamgroup.approval.decision',
} as const;

export const TeamStructurePayloadSchema = z.object({
  sharedProjectId: Uuid, settings: TeamOrchestrationSettingsSchema,
  members: z.array(z.object({
    agentId: Id, handle: z.string().min(2).max(32), role: TeamAgentRoleSchema, fallbackRank: z.number().int().min(1).max(4).nullable(),
    ownerAccountId: Uuid, deviceId: Uuid, state: TeamAgentStateSchema, currentTask: z.string().max(300).nullable(),
  }).strict()).max(64),
  leaderHistory: z.array(z.object({
    id: Id, at: IsoTime, fromAgentId: Id.nullable(), toAgentId: Id.nullable(),
    reason: z.enum(['manual', 'fallback-quota', 'fallback-offline', 'restored', 'removed']), byAccountId: Uuid.nullable(),
  }).strict()).max(50),
  needsLeader: z.boolean(),
}).strict();

export const TeamConsentPayloadSchema = z.object({
  sharedProjectId: Uuid, agentIds: z.array(Id).max(8), permissionLevel: TeamPermissionLevelSchema,
  settingsVersion: z.number().int().min(1), disclaimerVersion: z.string().max(40),
  state: z.enum(['granted', 'paused', 'revoked']), at: IsoTime,
}).strict();

export const TeamArtifactRefSchema = z.object({
  /** Commit on the producing device, transferred with the existing distributed Git API into an isolated ref. */
  revision: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/), path: z.string().min(1).max(4096).optional(),
  taskId: Id.optional(), transferId: Id.optional(),
}).strict();

export const TeamDeliveryPayloadSchema = z.object({
  sharedProjectId: Uuid, deliveryId: Id, groupId: Id, requestId: Id, agentId: Id,
  role: TeamAgentRoleSchema, kind: z.enum(['request', 'assignment', 'message', 'result']),
  /** Full prompt for the agent turn, built by the host (instructions + content). Bounded. */
  content: z.string().min(1).max(100_000),
  hop: z.number().int().min(0).max(12),
  permissionLevel: TeamPermissionLevelSchema, settingsVersion: z.number().int().min(1),
  taskId: Id.optional(),
  /** Git base the run should start from, if known. */
  baseRevision: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/).optional(),
  inputArtifacts: z.array(TeamArtifactRefSchema).max(30).default([]),
  /** Device that should receive committed artifacts (the orchestrator's device). */
  integrationDeviceId: Uuid,
  issuedAt: IsoTime,
}).strict();
export type TeamDeliveryPayload = z.infer<typeof TeamDeliveryPayloadSchema>;

export const TeamInterruptPayloadSchema = z.object({ sharedProjectId: Uuid, deliveryId: Id, reason: z.string().max(300) }).strict();

export const TeamDeliveryStatusPayloadSchema = z.object({
  sharedProjectId: Uuid, deliveryId: Id, agentId: Id,
  status: z.enum(['accepted', 'running', 'awaiting-approval', 'completed', 'failed', 'interrupted', 'rejected']),
  /** Remote run id on the owner device (opaque to the host). */
  runId: Id.nullable(),
  /** Final assistant text for completed runs; scrubbed and bounded. */
  finalText: z.string().max(50_000).optional(),
  artifacts: z.array(TeamArtifactRefSchema).max(30).default([]),
  failure: ProviderFailureSchema.optional(),
  /** Why the owner device refused, e.g. consent missing, needs re-consent, paused. */
  rejection: z.enum(['no-consent', 'needs-reconsent', 'paused', 'agent-unavailable', 'busy', 'invalid']).optional(),
  at: IsoTime,
}).strict();
export type TeamDeliveryStatusPayload = z.infer<typeof TeamDeliveryStatusPayloadSchema>;

export const TeamToolCallPayloadSchema = z.object({
  sharedProjectId: Uuid, deliveryId: Id, callId: Id, agentId: Id,
  tool: z.enum(['team_members', 'team_inbox', 'team_assign', 'team_message', 'team_artifact', 'team_status']),
  /** Arguments are validated on the host with the existing TeamAssign/TeamMessage/TeamArtifact/TeamStatus schemas. */
  args: z.record(z.string(), z.unknown()),
}).strict();
export const TeamToolResultPayloadSchema = z.object({
  sharedProjectId: Uuid, deliveryId: Id, callId: Id, ok: z.boolean(),
  result: z.unknown().optional(), error: z.string().max(2_000).optional(),
}).strict();

export const TeamActivityPayloadSchema = z.object({
  sharedProjectId: Uuid, agentId: Id, state: TeamAgentStateSchema, runId: Id.nullable(),
  entries: z.array(TeamAgentActivityEntrySchema).max(50),
}).strict();

export const TeamApprovalRequestPayloadSchema = z.object({
  sharedProjectId: Uuid, deliveryId: Id, approvalId: Id, agentId: Id,
  /** Scrubbed one-line description of what the agent wants to do. */
  summary: z.string().min(1).max(2_000), kind: z.string().max(60), expiresAt: IsoTime,
}).strict();
export const TeamApprovalDecisionPayloadSchema = z.object({
  sharedProjectId: Uuid, deliveryId: Id, approvalId: Id, decision: z.enum(['approved', 'denied']),
}).strict();
