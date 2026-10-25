import { AddTeamAgentSchema, EnableTeamOrchestrationSchema, TeamStructureChangeSchema, UpdateTeamOrchestrationSchema } from '@mingle/contracts';
import type { TeamRouteAdder } from '../types.ts';
import type { TeamOrchestrationHost } from './service.ts';

export function registerTeamOrchestrationHostRoutes(add: TeamRouteAdder, host: TeamOrchestrationHost): void {
  add('GET', '/api/projects/:projectId/team-agents', (ctx) => host.availableAgents(ctx.params.projectId!));
  add('POST', '/api/sessions/:id/team-agents', async (ctx) => host.addAgentToSession(ctx.params.id!, await ctx.body(AddTeamAgentSchema)));
  add('POST', '/api/groups/:id/team-agents', async (ctx) => host.addAgentToGroup(ctx.params.id!, await ctx.body(AddTeamAgentSchema)));
  add('POST', '/api/projects/:projectId/team-orchestration/enable', async (ctx) =>
    host.enable(ctx.params.projectId!, await ctx.body(EnableTeamOrchestrationSchema)));
  add('PATCH', '/api/projects/:projectId/team-orchestration', async (ctx) =>
    host.update(ctx.params.projectId!, await ctx.body(UpdateTeamOrchestrationSchema)));
  add('GET', '/api/projects/:projectId/team-structure', (ctx) => host.structure(ctx.params.projectId!));
  add('POST', '/api/projects/:projectId/team-structure/changes', async (ctx) =>
    host.change(ctx.params.projectId!, await ctx.body(TeamStructureChangeSchema)));
}
