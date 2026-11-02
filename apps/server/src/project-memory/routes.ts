import {
  CreateProjectMemorySchema, PatchProjectMemorySchema, ProjectMemoryHistoryQuerySchema, ProjectMemoryPreviewQuerySchema, ProjectMemoryQuerySchema,
} from '@mingle/contracts';
import { z } from 'zod';
import type { Ctx } from '../routes.ts';
import { HttpError, conflict } from '../util.ts';
import type { ProjectMemoryService } from './service.ts';
import type { ProjectMemoryTeamSync } from './sync.ts';

type AddRoute = (method: string, path: string, handler: (context: Ctx) => unknown | Promise<unknown>) => unknown;
const PatchSyncBody = z.object({}).strict();
const ID = /^[A-Za-z0-9_.-]{1,100}$/;

function id(ctx: Ctx, key: string): string {
  const value = ctx.params[key];
  if (!value || !ID.test(value)) throw new HttpError(404, key === 'projectId' ? 'Project not found.' : 'Memory entry not found.');
  return value;
}

function query(ctx: Ctx): Record<string, string> { return Object.fromEntries(ctx.url.searchParams); }

/** Local project memory: read/search/history for everyone, explicit human create/edit/pin/retire. Static paths register before `:entryId`. */
export function registerProjectMemoryRoutes(add: AddRoute, service: ProjectMemoryService, sync: () => ProjectMemoryTeamSync | null, Reply: new (status: number, body: unknown) => unknown): void {
  add('GET', '/api/projects/:projectId/memory', (ctx) => {
    const projectId = id(ctx, 'projectId');
    const parsed = ProjectMemoryQuerySchema.parse(query(ctx));
    sync()?.projectOpened(projectId);
    return service.list(projectId, parsed);
  });
  add('POST', '/api/projects/:projectId/memory', async (ctx) => {
    const result = await service.humanCreate(id(ctx, 'projectId'), await ctx.body(CreateProjectMemorySchema));
    return new Reply(result.outcome === 'created' ? 201 : 200, result);
  });
  add('GET', '/api/projects/:projectId/memory/context-preview', (ctx) =>
    service.contextPreview(id(ctx, 'projectId'), ProjectMemoryPreviewQuerySchema.parse(query(ctx)).query));
  add('POST', '/api/projects/:projectId/memory/sync', async (ctx) => {
    const projectId = id(ctx, 'projectId');
    const active = sync();
    const sharing = service.sharing(projectId);
    if (!active || !sharing.shared) throw conflict('This project is not shared with a team.');
    if (!sharing.localDeviceId) throw conflict('Register this device with the team to sync project memory.');
    await ctx.body(PatchSyncBody);
    await active.publish(projectId);
    return new Reply(202, { requested: await active.requestBackfill(projectId, true) });
  });
  add('GET', '/api/projects/:projectId/memory/:entryId', (ctx) => service.get(id(ctx, 'projectId'), id(ctx, 'entryId')));
  add('GET', '/api/projects/:projectId/memory/:entryId/history', (ctx) =>
    service.history(id(ctx, 'projectId'), id(ctx, 'entryId'), ProjectMemoryHistoryQuerySchema.parse(query(ctx))));
  add('PATCH', '/api/projects/:projectId/memory/:entryId', async (ctx) =>
    service.humanPatch(id(ctx, 'projectId'), id(ctx, 'entryId'), await ctx.body(PatchProjectMemorySchema)));
  add('GET', '/api/sessions/:sessionId/memory-injections', (ctx) => {
    const limit = Math.min(50, Math.max(1, Number(ctx.url.searchParams.get('limit') ?? 20) || 20));
    return service.injections(id(ctx, 'sessionId'), limit);
  });
}
