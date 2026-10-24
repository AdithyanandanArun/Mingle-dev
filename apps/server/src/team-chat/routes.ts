import { ImportTeamChatHistorySchema, SendTeamChatMessageSchema, TeamChatPageQuerySchema } from '../../../../packages/contracts/src/team-chat.ts';
import type { Ctx } from '../routes.ts';
import { HttpError } from '../util.ts';
import type { TeamChatService } from './service.ts';

type AddRoute = (method: string, path: string, handler: (context: Ctx) => unknown | Promise<unknown>) => unknown;

function projectId(ctx: Ctx): string {
  const id = ctx.params.projectId;
  if (!id || !/^[A-Za-z0-9_.-]{1,100}$/.test(id)) throw new HttpError(404, 'Project not found.');
  return id;
}

/** Team chat APIs share the loopback server guard and validate every request at the route boundary. */
export function registerTeamChatRoutes(add: AddRoute, service: TeamChatService): void {
  add('GET', '/api/projects/:projectId/team-chat', (ctx) => {
    const query = TeamChatPageQuerySchema.parse(Object.fromEntries(ctx.url.searchParams));
    return service.snapshot(projectId(ctx), query);
  });
  add('POST', '/api/projects/:projectId/team-chat/messages', async (ctx) =>
    service.send(projectId(ctx), await ctx.body(SendTeamChatMessageSchema)));
  add('POST', '/api/projects/:projectId/team-chat/import', async (ctx) =>
    service.importHistory(projectId(ctx), (await ctx.body(ImportTeamChatHistorySchema)).sessionId));
}
