import { z } from 'zod';
import { EffortSchema, PolicySchema } from './provider-config';

export const ProjectCollaborationRoleSchema = z.enum(['member', 'admin']);
export type ProjectCollaborationRole = z.infer<typeof ProjectCollaborationRoleSchema>;

export const ProjectCollaborationInvitationStatusSchema = z.enum(['pending', 'accepted', 'revoked', 'expired']);
export type ProjectCollaborationInvitationStatus = z.infer<typeof ProjectCollaborationInvitationStatusSchema>;

export const ProjectCollaborationEmailSchema = z.string().trim().email().max(254).transform((email) => email.toLowerCase());
export const ProjectInvitationTokenSchema = z.string().min(43).max(128).regex(/^[A-Za-z0-9_-]+$/);
/** The existing distributed execution roster publishes only these local runtimes. */
export const ProjectInvitationAgentProviderSchema = z.enum(['claude', 'codex', 'opencode']);

export const CreateProjectInvitationSchema = z.object({
  email: ProjectCollaborationEmailSchema,
  role: ProjectCollaborationRoleSchema.default('member'),
}).strict();
export type CreateProjectInvitationInput = z.infer<typeof CreateProjectInvitationSchema>;

export const PreviewProjectInvitationSchema = z.object({ token: ProjectInvitationTokenSchema }).strict();
export type PreviewProjectInvitationInput = z.infer<typeof PreviewProjectInvitationSchema>;

const ProjectInvitationJoinAgentSchema = z.object({
  provider: ProjectInvitationAgentProviderSchema,
  model: z.string().trim().min(1).max(150),
  effort: EffortSchema,
  policy: PolicySchema,
}).strict();

export const JoinProjectInvitationSchema = z.object({
  token: ProjectInvitationTokenSchema,
  localProjectId: z.string().trim().min(1).max(100),
  agent: ProjectInvitationJoinAgentSchema.optional(),
  agents: z.array(ProjectInvitationJoinAgentSchema).min(1).max(4).optional(),
}).strict().refine((value) => (value.agent !== undefined) !== (value.agents !== undefined), {
  message: 'Choose either one legacy agent or an agents list, but not both.',
});
export type JoinProjectInvitationInput = z.infer<typeof JoinProjectInvitationSchema>;

export interface ProjectCollaborationProject {
  teamId: string;
  sharedProjectId: string;
  name: string;
  repositoryUrl: string;
}

export interface ProjectCollaborationMember {
  accountId: string;
  email: string | null;
  displayName: string | null;
  role: 'leader' | 'admin' | 'member';
  status: 'active';
}

export interface ProjectCollaborationAgent {
  id: string;
  name: string;
  accountId: string;
  deviceId: string;
  projectId: string;
  sessionId: string | null;
  provider: string | null;
  model: string | null;
  state: string;
}

export interface ProjectCollaborationInvitation {
  id: string;
  email: string;
  role: ProjectCollaborationRole;
  status: ProjectCollaborationInvitationStatus;
  createdAt: string;
  expiresAt: string;
  invitedByAccountId: string;
}

export interface ProjectCollaborationSnapshot {
  project: ProjectCollaborationProject | null;
  members: ProjectCollaborationMember[];
  agents: ProjectCollaborationAgent[];
  invitations: ProjectCollaborationInvitation[];
  email: { configured: boolean; message?: string };
}

export interface ProjectInvitationPreview {
  invitationId: string;
  projectName: string;
  repositoryUrl: string;
  email: string;
  expiresAt: string;
  role: ProjectCollaborationRole;
  /** Optional public inviter details, when provided by the preview service. */
  inviterDisplayName?: string;
  inviterEmail?: string;
}

export interface ProjectInvitationCreateResult {
  invitation: Omit<ProjectCollaborationInvitation, 'createdAt' | 'invitedByAccountId'>;
  delivery: { status: 'sent' | 'not_configured' | 'failed'; message: string };
  /** Only present when delivery was not confirmed. Never persisted or emitted as an event. */
  joinUrl?: string;
}

export interface ProjectInvitationJoinResult {
  projectId: string;
  sessionId: string;
  sessionIds: string[];
  teamId: string;
  sharedProjectId: string;
  alreadyJoined: boolean;
}
