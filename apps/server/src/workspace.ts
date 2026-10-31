import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CreateProjectSchema, CreateSessionSchema, UpdateSessionSchema } from '@mingle/contracts';
import type { Project, ProviderInfo, Session } from '@mingle/contracts';
import type { z } from 'zod';
import { addWorktree, repoInfo } from './git.ts';
import type { RuntimeLike } from './app-types.ts';
import type { Store } from './store.ts';
import { badRequest, conflict, newId, notFound, slugify } from './util.ts';
import { resolveRunConfig } from './session-config.ts';
import { defaultModel } from './provider-config.ts';

type CreateProject = z.infer<typeof CreateProjectSchema>;
type CreateSession = z.infer<typeof CreateSessionSchema>;

/** Project and session lifecycle: canonical paths, worktree isolation, archival. */
export class WorkspaceService {
  private readonly preparing = new Map<string, number>();
  constructor(private readonly store: Store, private readonly dataDir: string, private readonly runtime: RuntimeLike,
    private readonly getProviders: () => ProviderInfo[] | null = () => null) {}

  async createProject(input: CreateProject): Promise<{ project: Project; created: boolean }> {
    let requested = input.path;
    if (/[\x00-\x1f\x7f]/.test(requested)) throw badRequest('Project path contains control characters');
    if (requested === '~' || requested.startsWith('~/') || process.platform === 'win32' && requested.startsWith('~\\')) requested = path.join(os.homedir(), requested.slice(1));
    if (!path.isAbsolute(requested)) throw badRequest('Project path must be absolute');
    if (process.platform === 'win32' && !/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/?]+[\\/][^\\/?]+(?:[\\/]|$))/.test(requested)) throw badRequest('Project path must include a drive or network share');
    let real: string;
    try {
      real = await fsp.realpath(requested);
    } catch {
      throw badRequest('Project path does not exist');
    }
    const stat = await fsp.stat(real);
    if (!stat.isDirectory()) throw badRequest('Project path is not a directory');
    if (real === path.parse(real).root) throw badRequest('Refusing to open the filesystem root as a project');
    const existing = this.store.getProjectByPath(real, true);
    if (existing) {
      if (this.store.getProject(existing.id)) return { project: existing, created: false };
      const project = this.store.tx(() => {
        const restored = this.store.restoreProject(existing.id);
        this.store.recordEvent({ projectId: restored.id, type: 'project.restored', summary: `Project reopened: ${restored.name}`, payload: { projectId: restored.id } });
        return restored;
      });
      return { project, created: false };
    }
    const project = this.store.tx(() => {
      const created = this.store.insertProject({ name: input.name, path: real });
      this.store.recordEvent({ projectId: created.id, type: 'project.created', summary: `Project opened: ${created.name}`, payload: { projectId: created.id } });
      return created;
    });
    return { project, created: true };
  }

  renameProject(id: string, name: string): Project {
    const project = this.store.getProject(id);
    if (!project) throw notFound('Project not found');
    if (project.name === name) return project;
    return this.store.tx(() => {
      const updated = this.store.renameProject(id, name);
      this.store.recordEvent({ projectId: id, type: 'project.renamed', summary: `Project renamed: ${project.name} → ${name}`, payload: { from: project.name, to: name } });
      return updated;
    });
  }

  /** Removes the project from Mingle. Sessions, native history, repository files and worktrees remain intact. */
  removeProject(id: string): string[] {
    const project = this.store.getProject(id);
    if (!project) throw notFound('Project not found');
    if ((this.preparing.get(id) ?? 0) > 0) throw conflict('Wait for session creation to finish before removing this project.');
    const sessions = this.store.listSessions(id);
    if (sessions.some((session) => this.runtime.isActive(session.id) || session.status === 'running' || session.status === 'waiting')) {
      throw conflict('Stop the project’s agents before removing it.');
    }
    const dispatching = this.store.db.prepare("SELECT 1 FROM group_deliveries d JOIN conversation_groups g ON g.id = d.group_id WHERE g.project_id = ? AND d.status = 'running' LIMIT 1").get(id);
    if (dispatching) throw conflict('Stop the project’s team work before removing it.');
    this.store.tx(() => {
      this.store.removeProject(id);
      this.store.recordEvent({ projectId: id, type: 'project.removed', summary: `Project removed from Mingle: ${project.name}`, payload: { projectId: id, filesKept: true } });
    });
    return sessions.map((session) => session.id);
  }

  async createSession(input: CreateSession): Promise<Session> {
    const project = this.store.getProject(input.projectId);
    if (!project) throw notFound('Project not found');
    this.preparing.set(project.id, (this.preparing.get(project.id) ?? 0) + 1);
    try { return await this.prepareSession(input, project); }
    finally {
      const remaining = (this.preparing.get(project.id) ?? 1) - 1;
      if (remaining > 0) this.preparing.set(project.id, remaining);
      else this.preparing.delete(project.id);
    }
  }

  private async prepareSession(input: CreateSession, project: Project): Promise<Session> {
    const settings = this.store.getSettings();
    const provider = input.provider ?? settings.defaultProvider;
    const model = input.model ?? defaultModel(provider, settings);
    const name = input.name ?? `Session ${this.store.listSessions(project.id).length + 1}`;
    const { effort, policy, serviceTier } = resolveRunConfig(this.getProviders()?.find((row) => row.id === provider), {
      provider, model, effort: input.effort ?? settings.defaultEffort, policy: input.policy ?? settings.defaultPolicy,
      serviceTier: input.serviceTier ?? settings.defaultServiceTier ?? 'standard',
    }, { effort: input.effort !== undefined, policy: input.policy !== undefined, serviceTier: input.serviceTier !== undefined });
    const isolated = input.isolated ?? settings.defaultIsolated;
    const id = newId('ses');
    let worktreePath = project.path;
    let branch: string | null = null;
    const info = await repoInfo(project.path);
    let worktreeBaseRevision = info.head;
    let isolationNotice: string | undefined;
    let effectiveIsolated = isolated;
    if (isolated && (!info.isRepo || !info.hasHead)) {
      effectiveIsolated = false;
      isolationNotice = !info.isRepo
        ? "This folder isn't a Git repository yet, so this session works directly in the folder. Set up Git to give sessions their own isolated copies."
        : 'This Git repository has no commits yet, so this session works directly in the folder. Create an initial commit to give sessions their own isolated copies.';
    }
    if (effectiveIsolated) {
      branch = `mingle/${slugify(name)}-${id.slice(4, 12)}`;
      const target = path.join(this.dataDir, 'worktrees', project.id, id);
      await addWorktree(project.path, target, branch);
      // A project that lives in a sub-directory of its repository keeps the same relative position in the worktree.
      worktreePath = info.prefix ? path.join(await fsp.realpath(target), ...info.prefix.split('/')) : await fsp.realpath(target);
      worktreeBaseRevision = (await repoInfo(worktreePath)).head;
    } else if (info.isRepo && info.hasHead) {
      branch = info.branch;
    }
    return this.store.tx(() => {
      const session = this.store.insertSession({ id, projectId: project.id, name, provider, model, effort, policy, serviceTier, isolated: effectiveIsolated, worktreePath, branch });
      if (isolationNotice) session.isolationNotice = isolationNotice;
      this.store.db.prepare(`INSERT INTO session_worktree_bases(session_id,base_revision,created_at) VALUES(?,?,?)`)
        .run(id, worktreeBaseRevision, new Date().toISOString());
      this.store.recordEvent({ projectId: project.id, sessionId: id, type: 'session.created', summary: `Session created: ${session.name}`, payload: { provider: session.provider, model: session.model, isolated: session.isolated, branch } });
      if (isolationNotice) this.store.insertMessage({ sessionId: id, role: 'system', kind: 'info', content: isolationNotice });
      return session;
    });
  }

  updateSession(id: string, patch: z.infer<typeof UpdateSessionSchema>): Session {
    const session = this.store.getSession(id);
    if (!session) throw notFound('Session not found');
    const changingRun = (['provider', 'model', 'effort', 'policy', 'serviceTier'] as const).some((key) => patch[key] !== undefined && patch[key] !== session[key]);
    if (changingRun && (this.runtime.isActive(id) || session.status === 'running' || session.status === 'waiting')) {
      throw conflict('Wait for this run to finish or interrupt it before changing its model or effort');
    }
    if (patch.provider && patch.provider !== session.provider) {
      if (session.providerSessionId) throw conflict('This conversation belongs to its current provider. Start a new session to use another provider.');
      const settings = this.store.getSettings();
      patch = { ...patch, model: patch.model ?? defaultModel(patch.provider, settings) };
    }
    if (changingRun) {
      const proposed = { ...session, ...patch };
      const resolved = resolveRunConfig(this.getProviders()?.find((row) => row.id === proposed.provider), proposed,
        { effort: patch.effort !== undefined, policy: patch.policy !== undefined, serviceTier: patch.serviceTier !== undefined });
      patch = { ...patch, effort: resolved.effort, policy: resolved.policy, serviceTier: resolved.serviceTier };
    }
    const changes = Object.fromEntries(Object.entries(patch).filter(([key, value]) => value !== undefined && value !== session[key as keyof Session]));
    if (!Object.keys(changes).length) return session;
    return this.store.tx(() => {
      const updated = this.store.updateSession(id, changes);
      const organizationOnly = Object.keys(changes).every((key) => key === 'pinned' || key === 'unread');
      if (organizationOnly) {
        this.store.touch();
        return updated;
      }
      const renamed = Object.keys(changes).length === 1 && 'name' in changes;
      this.store.recordEvent({
        projectId: session.projectId, sessionId: id, type: renamed ? 'session.renamed' : 'session.updated',
        summary: renamed ? `Session renamed: ${session.name} → ${updated.name}` : `Session settings updated: ${updated.name}`,
        payload: renamed ? { from: session.name, to: updated.name } : { fields: Object.keys(changes), model: updated.model, effort: updated.effort, provider: updated.provider },
      });
      return updated;
    });
  }

  /** Archives session metadata. The worktree and its branch are intentionally left on disk. */
  archiveSession(id: string): void {
    const session = this.store.getSession(id);
    if (!session) throw notFound('Session not found');
    if (this.runtime.isActive(id) || session.status === 'running' || session.status === 'waiting') throw conflict('Interrupt the running session before archiving it');
    this.store.tx(() => {
      const tasks = this.store.unassignTasksOfSession(id);
      this.store.archiveSession(id);
      this.store.recordEvent({ projectId: session.projectId, sessionId: id, type: 'session.archived', summary: `Session archived: ${session.name}`, payload: { worktreeKept: session.worktreePath, unassignedTasks: tasks.map((t) => t.id) } });
    });
  }

  /** Resolves the directory a project- or session-scoped request operates on. */
  resolveScope(projectId: string, sessionId?: string): { project: Project; root: string; session?: Session } {
    const project = this.store.getProject(projectId);
    if (!project) throw notFound('Project not found');
    if (!sessionId) return { project, root: project.path };
    const session = this.store.getSession(sessionId);
    if (!session || session.projectId !== project.id) throw notFound('Session not found in this project');
    return { project, root: session.worktreePath, session };
  }
}
