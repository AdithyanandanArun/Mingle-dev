import { randomUUID } from 'node:crypto';
import type {
  MemoryRememberToolInput, MemoryRetireToolInput, MemorySearchToolInput, MemoryUpdateToolInput, PatchProjectMemoryInput, CreateProjectMemoryInput,
  ProjectMemoryAuthor, ProjectMemoryContextPreview, ProjectMemoryCounts, ProjectMemoryEntry, ProjectMemoryEntryDetail, ProjectMemoryFileRef,
  ProjectMemoryHistoryResponse, ProjectMemoryInjection, ProjectMemoryInjectionsResponse, ProjectMemoryKind, ProjectMemoryListResponse,
  ProjectMemoryCausalProof, ProjectMemoryOp, ProjectMemoryQuery, ProjectMemoryRevision, ProjectMemoryRevisionSnapshot, ProjectMemorySharing, ProjectMemorySourceRef,
  ProjectMemorySyncRecord, ProjectMemoryWriteResult, Session,
} from '@mingle/contracts';
import { PROJECT_MEMORY_LIMITS, ProjectMemorySyncRecordSchema } from '@mingle/contracts';
import { git } from '../git.ts';
import type { Store } from '../store.ts';
import { badRequest, conflict, notFound } from '../util.ts';
import { MemoryRepo, type EntryRow, type RevisionRow } from './repo.ts';
import { profileQuery, rank, renderContext, selectForContext, toEntry } from './retrieval.ts';
import { bodyKey, checkMemoryPath, cleanText, detectSecret, jaccard, titleKey, tokenize } from './safety.ts';
import { hashProjectFile, StaleScanner } from './staleness.ts';

const SKEW_MS = 2 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Wired by the team-sync layer; absent for projects that are not shared. */
export interface MemoryTeamHooks {
  identity(projectId: string): { accountId: string | null; deviceId: string | null };
  sharing(projectId: string): ProjectMemorySharing;
  /** A local revision was written and should be published when the project is team-bound. */
  localRevision(projectId: string): void;
  requestBackfill(projectId: string): Promise<number>;
}

export interface MemoryServiceOptions {
  now?: () => number;
  log?: (level: 'info' | 'warn' | 'error', message: string, error?: unknown) => void;
  localUser?: () => { accountId: string | null; displayName: string | null };
  scanBudgetMs?: number;
  /** Test seams for the documented bounds. */
  liveLimit?: number; tombstoneLimit?: number;
  scanMinIntervalMs?: number;
}

export interface AgentContext { session: Session; runId: string }
type Actor = { kind: 'human' } | { kind: 'agent'; session: Session; runId: string };
type Draft = Omit<ProjectMemoryRevisionSnapshot, never>;
type Claim = 'tentative' | 'evidenced';
export type RemoteResult = 'applied' | 'duplicate' | 'ignored' | 'pending';

function snapshotOf(entry: EntryRow): ProjectMemoryRevisionSnapshot {
  return {
    kind: entry.kind, title: entry.title, body: entry.body, status: entry.status, pinned: entry.pinned, retired: entry.retired,
    humanVerified: entry.humanVerified, files: entry.files, sources: entry.sources,
  };
}

function changedFields(before: ProjectMemoryRevisionSnapshot | null, after: ProjectMemoryRevisionSnapshot): ProjectMemoryRevision['changed'] {
  if (!before) return ['kind', 'title', 'body', 'status', 'files', 'sources'];
  const out: ProjectMemoryRevision['changed'] = [];
  for (const key of ['kind', 'title', 'body', 'status', 'pinned', 'retired'] as const) if (before[key] !== after[key]) out.push(key);
  if (JSON.stringify(before.files.map((f) => [f.path, f.revision])) !== JSON.stringify(after.files.map((f) => [f.path, f.revision]))) out.push('files');
  if (JSON.stringify(before.sources) !== JSON.stringify(after.sources)) out.push('sources');
  return out;
}

/**
 * Deterministic head selection: human control epoch first, then revision, author, time and record id.
 * Every device applying the same set of records therefore chooses the same head.
 */
function outranks(record: ProjectMemorySyncRecord, head: EntryRow, headLineage?: { epoch: number }): boolean {
  const oldLineage = record.lineage;
  // A received record carrying an older human control epoch is stale even if its local revision counter is larger.
  if (oldLineage && headLineage && oldLineage.epoch !== headLineage.epoch) return oldLineage.epoch > headLineage.epoch;
  if (record.revision !== head.revision) return record.revision > head.revision;
  const recordHuman = record.author.kind === 'human';
  if (recordHuman !== (head.updatedBy.kind === 'human')) return recordHuman;
  if (record.at !== head.headAt) return record.at > head.headAt;
  return record.id > head.headRecordId;
}

const emptyCounts = (): ProjectMemoryCounts => ({ live: 0, stale: 0, retired: 0, pinned: 0, tentative: 0, evidenced: 0 });

/** Local project memory: durable entries, revisions, bounded retrieval and run-scoped agent writes. */
export class ProjectMemoryService {
  readonly repo: MemoryRepo;
  private team: MemoryTeamHooks | null = null;
  private readonly scanner: StaleScanner;
  private readonly runWrites = new Map<string, number>();
  private readonly unsubscribe: () => void;
  private readonly now: () => number;
  private closed = false;

  constructor(readonly store: Store, private readonly options: MemoryServiceOptions = {}) {
    this.repo = new MemoryRepo(store.db);
    this.now = options.now ?? Date.now;
    this.scanner = new StaleScanner(this.repo, {
      now: this.now, nowIso: () => this.iso(), budgetMs: options.scanBudgetMs, minIntervalMs: options.scanMinIntervalMs,
    });
    // Local events only: a finished run may have changed files that entries rely on.
    this.unsubscribe = store.subscribe((event) => {
      if (!event?.projectId || !/^session\.run\.(completed|failed|interrupted)$/.test(event.type)) return;
      this.runWrites.delete(String((event.payload as { runId?: unknown }).runId ?? ''));
      void this.rescan(event.projectId, true);
    });
  }

  attachTeam(hooks: MemoryTeamHooks | null): void { this.team = hooks; }
  close(): void { this.closed = true; this.unsubscribe(); }
  private iso(): string { return new Date(this.now()).toISOString(); }
  private log(level: 'info' | 'warn' | 'error', message: string, error?: unknown): void { this.options.log?.(level, message, error); }

  // ---- identity ------------------------------------------------------------------------------------------------

  private humanAuthor(projectId: string): ProjectMemoryAuthor {
    const user = this.options.localUser?.() ?? { accountId: null, displayName: null };
    const identity = this.team?.identity(projectId) ?? { accountId: null, deviceId: null };
    return { kind: 'human', displayName: (user.displayName ?? 'You').slice(0, 120) || 'You', accountId: user.accountId ?? identity.accountId, deviceId: identity.deviceId };
  }

  private agentAuthor(session: Session, runId: string): ProjectMemoryAuthor {
    const identity = this.team?.identity(session.projectId) ?? { accountId: null, deviceId: null };
    const user = this.options.localUser?.();
    return {
      kind: 'agent', sessionId: session.id, runId, name: session.name.slice(0, 100) || 'Agent', provider: session.provider,
      model: session.model.slice(0, 150), accountId: identity.accountId ?? user?.accountId ?? null, deviceId: identity.deviceId,
    };
  }

  private project(projectId: string): { id: string; path: string } {
    const project = this.store.getProject(projectId);
    if (!project) throw notFound('Project not found.');
    return { id: project.id, path: project.path };
  }

  // ---- reads ---------------------------------------------------------------------------------------------------

  private async rescan(projectId: string, force = false, budgetMs?: number): Promise<void> {
    if (this.closed) return;
    const project = this.store.getProject(projectId);
    if (!project) return;
    try {
      const changed = await this.scanner.scan(project, { force, budgetMs });
      if (changed.length && !this.closed) this.store.recordEvent({ projectId, type: 'memory.stale', summary: 'Project memory staleness changed', payload: { entryIds: changed.slice(0, 50) } });
    } catch (error) { this.log('warn', 'Project memory staleness scan failed', error); }
  }

  sharing(projectId: string): ProjectMemorySharing {
    return this.team?.sharing(projectId) ?? {
      shared: false, teamId: null, sharedProjectId: null, localDeviceId: null, peerCount: 0, unpublished: 0, lastBackfillAt: null, lastReceivedAt: null, error: null,
    };
  }

  counts(projectId: string): ProjectMemoryCounts {
    const counts = emptyCounts();
    for (const entry of this.repo.listEntries(projectId, 'all')) {
      if (entry.retired) { counts.retired++; continue; }
      counts.live++;
      if (entry.stale) counts.stale++;
      if (entry.pinned) counts.pinned++;
      counts[entry.status]++;
    }
    return counts;
  }

  async list(projectId: string, query: ProjectMemoryQuery): Promise<ProjectMemoryListResponse> {
    this.project(projectId);
    await this.rescan(projectId, false, 250);
    const profile = profileQuery(query.q ?? '');
    const searching = profile.tokens.length > 0 || profile.paths.length > 0;
    let rows = this.repo.listEntries(projectId, query.include).filter((entry) => (!query.kind || entry.kind === query.kind)
      && (!query.status || entry.status === query.status) && (query.pinned === undefined || entry.pinned === query.pinned));
    let matched = rows.map((entry) => ({ entry, match: null as ReturnType<typeof rank>[number] | null }));
    if (searching) matched = rank(rows, profile, this.now()).filter((item) => item.textMatch).map((item) => ({ entry: item.entry, match: item }));
    else rows = rows.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    if (!searching) matched = rows.map((entry) => ({ entry, match: null }));
    const offset = query.cursor && /^\d{1,6}$/.test(query.cursor) ? Number(query.cursor) : 0;
    const page = matched.slice(offset, offset + query.limit);
    const next = offset + page.length < matched.length ? String(offset + page.length) : null;
    return {
      entries: page.map((item) => toEntry(item.entry, item.match)), total: matched.length, nextCursor: next, counts: this.counts(projectId),
      sharing: this.sharing(projectId),
      limits: { maxLiveEntries: PROJECT_MEMORY_LIMITS.maxLiveEntries, maxRevisionsPerEntry: PROJECT_MEMORY_LIMITS.maxRevisionsPerEntry },
    };
  }

  private requireEntry(projectId: string, entryId: string): EntryRow {
    const entry = UUID.test(entryId) ? this.repo.getEntry(entryId) : undefined;
    // An entry from another project is indistinguishable from a missing one.
    if (!entry || entry.projectId !== projectId) throw notFound('Memory entry not found.');
    return entry;
  }

  private revisionView(entry: EntryRow, row: RevisionRow): ProjectMemoryRevision {
    const siblings = this.repo.entryRecordForRevision(row.entryId, row.revision);
    const canonical = siblings.at(-1);
    return {
      id: row.recordId, entryId: row.entryId, revision: row.revision, parentRevision: row.parentRevision, op: row.op, at: row.at,
      author: row.author, note: row.note, snapshot: row.snapshot, changed: row.changed, received: row.received,
      superseded: siblings.length > 1 && canonical?.recordId !== row.recordId,
    };
  }

  async get(projectId: string, entryId: string): Promise<ProjectMemoryEntryDetail> {
    this.project(projectId);
    await this.rescan(projectId, false, 250);
    const entry = this.requireEntry(projectId, entryId);
    const rows = this.repo.listRecords(entry.id, 21, 0);
    return { entry: toEntry(entry, null), history: rows.slice(0, 20).map((row) => this.revisionView(entry, row)), historyTruncated: rows.length > 20 };
  }

  history(projectId: string, entryId: string, query: { limit: number; cursor?: string }): ProjectMemoryHistoryResponse {
    this.project(projectId);
    const entry = this.requireEntry(projectId, entryId);
    const offset = query.cursor && /^\d{1,6}$/.test(query.cursor) ? Number(query.cursor) : 0;
    const rows = this.repo.listRecords(entry.id, query.limit + 1, offset);
    const page = rows.slice(0, query.limit);
    return { entryId: entry.id, revisions: page.map((row) => this.revisionView(entry, row)), nextCursor: rows.length > query.limit ? String(offset + page.length) : null };
  }

  injections(sessionId: string, limit: number): ProjectMemoryInjectionsResponse {
    if (!this.store.getSession(sessionId, true)) throw notFound('Session not found.');
    return { injections: this.repo.listInjections(sessionId, Math.min(50, Math.max(1, limit))) };
  }

  // ---- run context ---------------------------------------------------------------------------------------------

  /**
   * Builds the bounded memory block for a run. Synchronous over stored state: stale marks come from the last scan and a fresh
   * scan is started in the background, so a run never waits on the file system.
   */
  buildRunContext(input: { session: Session; runId: string; prompt: string; tools: boolean }): string | undefined {
    const { session } = input;
    void this.rescan(session.projectId, false);
    const entries = this.repo.listEntries(session.projectId, 'live');
    if (!entries.length && !input.tools) return undefined;
    const query = profileQuery(input.prompt);
    const rendered = renderContext(selectForContext(entries, query, this.now()), input.tools);
    if (!rendered) return undefined;
    if (rendered.entries.length) {
      const injection: ProjectMemoryInjection = {
        runId: input.runId, sessionId: session.id, at: this.iso(), query: input.prompt.slice(0, 300), entries: rendered.entries,
        chars: rendered.chars, truncated: rendered.truncated,
      };
      this.repo.insertInjection(session.projectId, injection);
      this.store.recordEvent({ projectId: session.projectId, sessionId: session.id, type: 'memory.injected', summary: 'Project memory added to run context',
        payload: { sessionId: session.id, runId: input.runId, count: rendered.entries.length } });
    }
    return rendered.text;
  }

  async contextPreview(projectId: string, queryText: string): Promise<ProjectMemoryContextPreview> {
    this.project(projectId);
    await this.rescan(projectId, false, 250);
    const rendered = renderContext(selectForContext(this.repo.listEntries(projectId, 'live'), profileQuery(queryText), this.now()), true)!;
    return { injection: { at: this.iso(), query: queryText.slice(0, 300), entries: rendered.entries, chars: rendered.chars, truncated: rendered.truncated }, text: rendered.text };
  }

  // ---- evidence ------------------------------------------------------------------------------------------------

  private async verifyRefs(input: {
    files?: string[]; commits?: string[]; commands?: string[]; projectRoot: string; workRoot: string; session?: Session; runId?: string;
  }): Promise<{ files: ProjectMemoryFileRef[]; commits: ProjectMemorySourceRef[]; commands: ProjectMemorySourceRef[]; notices: string[] }> {
    const notices: string[] = [];
    const files: ProjectMemoryFileRef[] = [];
    const seen = new Set<string>();
    const verifiedAt = this.iso();
    for (const raw of input.files ?? []) {
      const checked = checkMemoryPath(raw);
      if (!checked.ok) { notices.push(`Ignored file "${raw.slice(0, 80)}": ${checked.reason}.`); continue; }
      if (seen.has(checked.path)) continue;
      seen.add(checked.path);
      if (files.length >= PROJECT_MEMORY_LIMITS.maxFilesPerEntry) { notices.push('Only the first 8 files were kept.'); break; }
      const state = await hashProjectFile(input.workRoot, checked.path);
      if (state.kind !== 'ok') { notices.push(`Ignored file "${checked.path}": it could not be read in this workspace.`); continue; }
      let baseRevision: string | null = null;
      if (input.workRoot !== input.projectRoot) {
        const base = await hashProjectFile(input.projectRoot, checked.path);
        if (base.kind === 'ok' && base.hash !== state.hash) baseRevision = base.hash;
      }
      files.push({ path: checked.path, revision: state.hash, baseRevision, verifiedAt });
    }
    const commits: ProjectMemorySourceRef[] = [];
    for (const raw of input.commits ?? []) {
      const sha = raw.toLowerCase();
      if (commits.some((source) => source.ref === sha)) continue;
      const result = await git(input.projectRoot, ['cat-file', '-e', `${sha}^{commit}`], { allowFailure: true, timeoutMs: 5_000 }).catch(() => null);
      if (result?.code === 0) commits.push({ type: 'commit', ref: sha });
      else notices.push(`Ignored commit ${sha.slice(0, 12)}: it was not found in this project's repository.`);
    }
    const commands: ProjectMemorySourceRef[] = [];
    const calls = input.runId ? this.store.listRunTools(input.runId) : [];
    for (const raw of input.commands ?? []) {
      const wanted = raw.replace(/\s+/g, ' ').trim();
      if (!wanted || commands.some((source) => source.ref === wanted)) continue;
      if (detectSecret(wanted)) { notices.push('Ignored a command that looked like it contained a secret.'); continue; }
      const ran = input.runId && calls.some((call) => call.category === 'command' && call.status === 'completed' && call.exitCode === 0
        && (call.command ?? '').replace(/\s+/g, ' ').includes(wanted));
      if (ran && input.runId) commands.push({ type: 'command', ref: wanted, runId: input.runId, exitCode: 0 });
      else notices.push(`Ignored command "${wanted.slice(0, 60)}": no completed run of it with exit code 0 was recorded in this run.`);
    }
    return { files, commits, commands, notices };
  }

  /**
   * `evidenced` means the references were checked by Mingle (a file at a recorded revision, a commit that exists, a command that
   * completed with exit 0 in the authoring run). It never means the text is true. The automatic `run` provenance reference
   * does not count, and a `verification` entry needs a completed successful command.
   */
  private statusFor(kind: ProjectMemoryKind, claim: Claim, files: ProjectMemoryFileRef[], sources: ProjectMemorySourceRef[]): { status: 'tentative' | 'evidenced'; notice?: string } {
    if (claim === 'tentative') return { status: 'tentative' };
    const checkedRefs = files.length + sources.filter((source) => source.type !== 'run').length;
    if (kind === 'verification') {
      return sources.some((source) => source.type === 'command') ? { status: 'evidenced' }
        : { status: 'tentative', notice: 'Kept as tentative: a verification needs a command that completed successfully in this run.' };
    }
    return checkedRefs > 0 ? { status: 'evidenced' }
      : { status: 'tentative', notice: 'Kept as tentative: no file, commit or command reference could be checked.' };
  }

  private screen(...parts: Array<string | undefined>): void {
    const hit = detectSecret(parts.filter(Boolean).join('\n'));
    if (hit) throw badRequest(`Memory was not saved: the text looks like it contains a secret (${hit}). Remove it and try again.`);
  }

  // ---- writes --------------------------------------------------------------------------------------------------

  private findDuplicate(projectId: string, draft: { kind: ProjectMemoryKind; title: string; body: string }, ignoreId?: string): EntryRow | undefined {
    const tKey = titleKey(draft.kind, draft.title, draft.body);
    const bKey = bodyKey(draft.body);
    const titleTokens = tokenize(draft.title);
    const bodyTokens = tokenize(draft.body);
    for (const entry of this.repo.listEntries(projectId, 'live')) {
      if (entry.id === ignoreId) continue;
      if (entry.bodyKey === bKey) return entry;
      if (entry.kind !== draft.kind) continue;
      if (entry.titleKey === tKey) return entry;
      // Near-identical wording only: both the title and the body must be very similar, so distinct entries are never overwritten.
      if (titleTokens.length >= 3 && bodyTokens.length >= 4 && jaccard(titleTokens, tokenize(entry.title)) >= 0.85
        && jaccard(bodyTokens, tokenize(entry.body)) >= 0.6) return entry;
    }
    return undefined;
  }

  private humanTombstone(projectId: string, draft: { kind: ProjectMemoryKind; title: string; body: string }): EntryRow | undefined {
    const tKey = titleKey(draft.kind, draft.title, draft.body);
    const bKey = bodyKey(draft.body);
    return this.repo.listEntries(projectId, 'retired').find((entry) => entry.retiredByHuman && (entry.bodyKey === bKey || (entry.kind === draft.kind && entry.titleKey === tKey)));
  }

  private emit(entry: EntryRow, op: ProjectMemoryOp, origin: 'local' | 'peer', sessionId?: string): void {
    this.store.recordEvent({ projectId: entry.projectId, sessionId: sessionId ?? null, type: 'memory.updated', summary: `Project memory ${op}: ${entry.title.slice(0, 80)}`,
      payload: { entryId: entry.id, revision: entry.revision, op, origin } });
  }

  /** Persists one new revision of an entry (local authorship). */
  private commit(input: {
    projectId: string; prior: EntryRow | null; entryId?: string; op: ProjectMemoryOp; draft: Draft; author: ProjectMemoryAuthor; note?: string | null;
    keepStale?: boolean; sessionId?: string;
  }): EntryRow {
    const { prior, draft, author } = input;
    const at = this.iso();
    const revision = prior ? prior.revision + 1 : 1;
    const recordId = randomUUID();
    const priorLineage = prior ? this.repo.lineageFor(prior.headRecordId) : undefined;
    const lineage = {
      parentId: prior?.headRecordId ?? null,
      controlId: author.kind === 'human' ? recordId : priorLineage?.controlId ?? null,
      epoch: Math.min(1_000_000, (priorLineage?.epoch ?? 0) + (author.kind === 'human' ? 1 : 0)),
    };
    const retiredNow = draft.retired && !prior?.retired;
    const row: EntryRow = {
      id: prior?.id ?? input.entryId ?? randomUUID(), projectId: input.projectId, kind: draft.kind, title: draft.title, body: draft.body, status: draft.status,
      pinned: draft.pinned, humanVerified: draft.humanVerified, revision, retired: draft.retired,
      retiredAt: draft.retired ? (retiredNow ? at : prior?.retiredAt ?? at) : null,
      retiredByHuman: draft.retired ? (retiredNow ? author.kind === 'human' : prior?.retiredByHuman ?? false) : false,
      createdAt: prior?.createdAt ?? at, updatedAt: at, author: prior?.author ?? author, updatedBy: author, files: draft.files, sources: draft.sources,
      titleKey: titleKey(draft.kind, draft.title, draft.body), bodyKey: bodyKey(draft.body), headRecordId: recordId, headAt: at,
      originDeviceId: null, stale: input.keepStale && !draft.retired ? prior?.stale ?? null : null,
    };
    this.repo.tx(() => {
      this.repo.insertRecord({
        recordId, entryId: row.id, projectId: row.projectId, revision, parentRevision: prior?.revision ?? null, op: input.op, at, createdAt: at, author,
        note: input.note ? input.note.slice(0, 300) : null, snapshot: draft, changed: changedFields(prior ? snapshotOf(prior) : null, draft),
        received: false, authorDeviceId: null, signature: null, teamId: null, sharedProjectId: null, publishedAt: null, lineage, causalValid: true,
      });
      this.repo.upsertEntry(row);
      this.repo.pruneRecords(row.id);
      if (retiredNow) this.compactTombstones(row.projectId);
    });
    this.emit(row, input.op, 'local', input.sessionId);
    this.team?.localRevision(row.projectId);
    return row;
  }

  private compactTombstones(projectId: string): void {
    const excess = this.repo.excessTombstones(projectId, this.options.tombstoneLimit ?? PROJECT_MEMORY_LIMITS.maxTombstones);
    if (!excess.length) return;
    for (const entry of excess) this.repo.deleteEntry(entry.id);
    // Keep exact retired IDs after deleting their bounded bodies/history; timestamps cannot identify an unrelated offline create.
    for (const entry of excess) this.repo.markRetiredId(projectId, entry.id, entry.headAt);
  }

  private assertCapacity(projectId: string): void {
    const limit = this.options.liveLimit ?? PROJECT_MEMORY_LIMITS.maxLiveEntries;
    if (this.repo.liveCount(projectId) >= limit) {
      throw conflict(`Project memory is full (${limit} live entries). Update an existing entry or retire one first.`);
    }
  }

  private checkWriteBudget(runId: string): void {
    const used = this.runWrites.get(runId) ?? 0;
    if (used >= PROJECT_MEMORY_LIMITS.maxAgentWritesPerRun) throw conflict(`This run already made ${PROJECT_MEMORY_LIMITS.maxAgentWritesPerRun} memory writes. Stop recording and continue with the task.`);
    this.runWrites.set(runId, used + 1);
  }

  private async remember(projectId: string, actor: Actor, input: {
    kind: ProjectMemoryKind; title: string; body: string; files?: string[]; commits?: string[]; commands?: string[]; claim: Claim; pinned?: boolean;
  }): Promise<ProjectMemoryWriteResult> {
    const project = this.project(projectId);
    const title = cleanText(input.title);
    const body = cleanText(input.body);
    if (title.length < 3 || !body) throw badRequest('A memory needs a title and a body.');
    this.screen(title, body, ...(input.files ?? []));
    const workRoot = actor.kind === 'agent' ? actor.session.worktreePath : project.path;
    const refs = await this.verifyRefs({ files: input.files, commits: input.commits, commands: input.commands, projectRoot: project.path, workRoot,
      session: actor.kind === 'agent' ? actor.session : undefined, runId: actor.kind === 'agent' ? actor.runId : undefined });
    const author = actor.kind === 'agent' ? this.agentAuthor(actor.session, actor.runId) : this.humanAuthor(projectId);
    const notices = [...refs.notices];
    const provenance: ProjectMemorySourceRef[] = actor.kind === 'agent' ? [{ type: 'run', ref: actor.runId }] : [];
    const duplicate = this.findDuplicate(projectId, { kind: input.kind, title, body });
    if (!duplicate && actor.kind === 'agent') {
      const tomb = this.humanTombstone(projectId, { kind: input.kind, title, body });
      if (tomb) throw conflict('A person retired an equivalent memory entry earlier, so it was not recreated.');
    }
    if (duplicate) {
      if (actor.kind === 'agent' && duplicate.pinned) {
        return { entry: toEntry(duplicate, null), outcome: 'unchanged', notices: [...notices, 'An equivalent pinned entry exists and is locked against agent edits.'] };
      }
      // Wording that only differs in case, spacing or punctuation is the same memory: keep the stored text.
      const sameText = duplicate.bodyKey === bodyKey(body);
      return this.applyUpdate(duplicate, actor, {
        kind: sameText ? duplicate.kind : input.kind, title: sameText ? duplicate.title : title, body: sameText ? duplicate.body : body, files: refs.files, newFiles: Boolean(input.files?.length), commits: refs.commits, commands: refs.commands,
        newCommits: Boolean(input.commits?.length), newCommands: Boolean(input.commands?.length), claim: input.claim, pinned: input.pinned, notices, merged: true,
        provenance,
      });
    }
    this.assertCapacity(projectId);
    if (actor.kind === 'agent') this.checkWriteBudget(actor.runId);
    const sources = [...provenance, ...refs.commits, ...refs.commands];
    const verdict = actor.kind === 'human'
      ? this.statusFor(input.kind, refs.files.length || refs.commits.length || refs.commands.length ? 'evidenced' : 'tentative', refs.files, sources)
      : this.statusFor(input.kind, input.claim, refs.files, sources);
    if (verdict.notice) notices.push(verdict.notice);
    const entry = this.commit({
      projectId, prior: null, op: 'create', author, sessionId: actor.kind === 'agent' ? actor.session.id : undefined,
      draft: { kind: input.kind, title, body, status: verdict.status, pinned: Boolean(input.pinned) && actor.kind === 'human', retired: false,
        humanVerified: actor.kind === 'human', files: refs.files, sources },
    });
    return { entry: toEntry(entry, null), outcome: 'created', notices: notices.slice(0, 10) };
  }

  private applyUpdate(prior: EntryRow, actor: Actor, change: {
    kind?: ProjectMemoryKind; title?: string; body?: string; files: ProjectMemoryFileRef[]; newFiles: boolean; commits: ProjectMemorySourceRef[];
    commands: ProjectMemorySourceRef[]; newCommits: boolean; newCommands: boolean; claim?: Claim; pinned?: boolean; notices: string[]; note?: string;
    merged?: boolean; provenance?: ProjectMemorySourceRef[]; reverify?: boolean;
  }): ProjectMemoryWriteResult {
    const kind = change.kind ?? prior.kind;
    const title = change.title ?? prior.title;
    const body = change.body ?? prior.body;
    const contentChanged = kind !== prior.kind || title !== prior.title || body !== prior.body;
    const files = change.newFiles ? change.files : prior.files;
    const keptSources = prior.sources.filter((source) => (source.type === 'commit' && !change.newCommits) || (source.type === 'command' && !change.newCommands));
    const provenance = change.provenance?.length ? change.provenance : prior.sources.filter((source) => source.type === 'run');
    const sources: ProjectMemorySourceRef[] = [...provenance, ...keptSources, ...(change.newCommits ? change.commits : []), ...(change.newCommands ? change.commands : [])];
    const refsChanged = change.newFiles || change.newCommits || change.newCommands;
    const notices = [...change.notices];
    let status = prior.status;
    if (actor.kind === 'human') {
      status = this.statusFor(kind, files.length || sources.some((s) => s.type !== 'run') ? 'evidenced' : 'tentative', files, sources).status;
    } else if (change.claim === 'evidenced' || contentChanged || refsChanged) {
      // New content is only as strong as the references supplied with it.
      const verdict = this.statusFor(kind, change.claim ?? 'tentative', files, sources);
      status = verdict.status;
      if (verdict.notice && change.claim === 'evidenced') notices.push(verdict.notice);
    }
    const pinned = change.pinned ?? prior.pinned;
    const onlyPin = actor.kind === 'human' && !contentChanged && !refsChanged && !change.reverify && pinned !== prior.pinned;
    const draft: Draft = {
      kind, title, body, status, pinned, retired: false, files, sources,
      humanVerified: actor.kind === 'human' ? (onlyPin ? prior.humanVerified : true) : contentChanged || refsChanged ? false : prior.humanVerified,
    };
    const before = snapshotOf(prior);
    const unchanged = !change.reverify && changedFields(before, draft).length === 0 && draft.humanVerified === before.humanVerified;
    if (unchanged) return { entry: toEntry(prior, null), outcome: 'unchanged', notices: notices.slice(0, 10) };
    if (actor.kind === 'agent') this.checkWriteBudget(actor.runId);
    const author = actor.kind === 'agent' ? this.agentAuthor(actor.session, actor.runId) : this.humanAuthor(prior.projectId);
    const entry = this.commit({
      projectId: prior.projectId, prior, op: onlyPin ? 'pin' : 'update', author, draft, note: change.note, keepStale: !change.newFiles && !change.reverify,
      sessionId: actor.kind === 'agent' ? actor.session.id : undefined,
    });
    return { entry: toEntry(entry, null), outcome: change.merged ? 'merged' : 'updated', notices: notices.slice(0, 10) };
  }

  async humanCreate(projectId: string, input: CreateProjectMemoryInput): Promise<ProjectMemoryWriteResult> {
    return this.remember(projectId, { kind: 'human' }, { kind: input.kind, title: input.title, body: input.body, files: input.files, claim: 'evidenced', pinned: input.pinned });
  }

  async humanPatch(projectId: string, entryId: string, input: PatchProjectMemoryInput): Promise<ProjectMemoryWriteResult> {
    const project = this.project(projectId);
    const prior = this.requireEntry(projectId, entryId);
    if (prior.revision !== input.expectedRevision || prior.headRecordId !== input.expectedHeadId) throw conflict(`Memory entry changed; current revision is ${prior.revision}.`);
    const actor: Actor = { kind: 'human' };
    const title = input.title === undefined ? undefined : cleanText(input.title);
    const body = input.body === undefined ? undefined : cleanText(input.body);
    if ((title !== undefined && title.length < 3) || (body !== undefined && !body)) throw badRequest('A memory needs a title and a body.');
    this.screen(title, body, ...(input.files ?? []));
    const author = this.humanAuthor(projectId);
    if (input.lifecycle === 'retired') {
      if (prior.retired) return { entry: toEntry(prior, null), outcome: 'unchanged', notices: [] };
      const entry = this.commit({ projectId, prior, op: 'retire', author, note: input.note, draft: { ...snapshotOf(prior), retired: true, humanVerified: true } });
      return { entry: toEntry(entry, null), outcome: 'updated', notices: [] };
    }
    const restoring = prior.retired && input.lifecycle === 'active';
    if (prior.retired && !restoring) throw conflict('This entry is retired. Restore it before editing.');
    if (restoring) this.assertCapacity(projectId);
    const reverify = input.lifecycle === 'active' && (restoring || Boolean(prior.stale));
    const notices: string[] = [];
    let files = prior.files;
    let newFiles = false;
    if (input.files !== undefined) {
      const refs = await this.verifyRefs({ files: input.files, commits: [], commands: [], projectRoot: project.path, workRoot: project.path });
      files = refs.files; newFiles = true; notices.push(...refs.notices);
    } else if (reverify && prior.files.length) {
      const refs = await this.verifyRefs({ files: prior.files.map((file) => file.path), commits: [], commands: [], projectRoot: project.path, workRoot: project.path });
      if (refs.files.length < prior.files.length) {
        notices.push(...refs.notices);
        if (!restoring) return { entry: toEntry(prior, null), outcome: 'unchanged', notices: [...notices, 'A referenced file no longer exists, so the entry stays stale. Edit its files to re-verify.'] };
      }
      files = refs.files; newFiles = true;
    }
    const kind = input.kind ?? prior.kind;
    const effectiveTitle = title ?? prior.title;
    const effectiveBody = body ?? prior.body;
    const dup = this.findDuplicate(projectId, { kind, title: effectiveTitle, body: effectiveBody }, prior.id);
    if (dup && (title !== undefined || body !== undefined || input.kind !== undefined)) throw conflict(`Another memory entry already says this ("${dup.title.slice(0, 60)}"). Edit that one instead.`);
    if (restoring) {
      const sources = prior.sources;
      const status = this.statusFor(kind, files.length || sources.some((s) => s.type !== 'run') ? 'evidenced' : 'tentative', files, sources).status;
      const entry = this.commit({ projectId, prior, op: 'restore', author, note: input.note,
        draft: { ...snapshotOf(prior), kind, title: effectiveTitle, body: effectiveBody, files, status, pinned: input.pinned ?? prior.pinned, retired: false, humanVerified: true } });
      return { entry: toEntry(entry, null), outcome: 'updated', notices };
    }
    return this.applyUpdate(prior, actor, { kind: input.kind, title, body, files, newFiles, commits: [], commands: [], newCommits: false, newCommands: false,
      pinned: input.pinned, notices, note: reverify && !input.note ? 'Re-verified against current files' : input.note, reverify });
  }

  // ---- agent tools ---------------------------------------------------------------------------------------------

  private agentEntry(ctx: AgentContext, id: string): EntryRow {
    return this.requireEntry(ctx.session.projectId, id);
  }

  async agentRemember(ctx: AgentContext, input: MemoryRememberToolInput): Promise<ProjectMemoryWriteResult> {
    return this.remember(ctx.session.projectId, { kind: 'agent', ...ctx }, { kind: input.kind, title: input.title, body: input.body, files: input.files,
      commits: input.commits, commands: input.commands, claim: input.evidence ?? 'tentative' });
  }

  async agentSearch(ctx: AgentContext, input: MemorySearchToolInput): Promise<{ entries: ProjectMemoryEntry[]; total: number }> {
    await this.rescan(ctx.session.projectId, false, 150);
    const profile = profileQuery(input.query ?? '');
    const searching = profile.tokens.length > 0 || profile.paths.length > 0;
    let rows = this.repo.listEntries(ctx.session.projectId, 'live').filter((entry) => (!input.kind || entry.kind === input.kind) && ((input.includeStale ?? true) || !entry.stale));
    const limit = Math.min(input.limit ?? 5, PROJECT_MEMORY_LIMITS.searchMaxResults);
    let matched: Array<{ entry: EntryRow; match: ReturnType<typeof rank>[number] | null }>;
    if (searching) matched = rank(rows, profile, this.now()).filter((item) => item.textMatch).map((item) => ({ entry: item.entry, match: item }));
    else {
      rows = rows.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
      matched = rows.map((entry) => ({ entry, match: null }));
    }
    return { entries: matched.slice(0, limit).map((item) => toEntry(item.entry, item.match)), total: matched.length };
  }

  async agentUpdate(ctx: AgentContext, input: MemoryUpdateToolInput): Promise<ProjectMemoryWriteResult> {
    const project = this.project(ctx.session.projectId);
    const prior = this.agentEntry(ctx, input.id);
    if (prior.retired) throw conflict('This memory entry is retired; only a person can restore it.');
    if (prior.pinned) throw conflict('This memory entry is pinned by a person and is locked against agent edits.');
    if (input.expectedRevision !== undefined && input.expectedRevision !== prior.revision) throw conflict(`Memory entry changed; current revision is ${prior.revision}. Search again.`);
    if (input.expectedHeadId !== undefined && input.expectedHeadId !== prior.headRecordId) throw conflict(`Memory entry changed; current revision is ${prior.revision}. Search again.`);
    const title = input.title === undefined ? undefined : cleanText(input.title);
    const body = input.body === undefined ? undefined : cleanText(input.body);
    if ((title !== undefined && title.length < 3) || (body !== undefined && !body)) throw badRequest('A memory needs a title and a body.');
    this.screen(title, body, input.note, ...(input.files ?? []));
    const kind = input.kind ?? prior.kind;
    const dup = this.findDuplicate(prior.projectId, { kind, title: title ?? prior.title, body: body ?? prior.body }, prior.id);
    if (dup && (title !== undefined || body !== undefined || input.kind !== undefined)) throw conflict(`Another memory entry already says this (id ${dup.id}). Update that one instead.`);
    const refs = await this.verifyRefs({ files: input.files, commits: input.commits, commands: input.commands, projectRoot: project.path, workRoot: ctx.session.worktreePath,
      session: ctx.session, runId: ctx.runId });
    return this.applyUpdate(prior, { kind: 'agent', ...ctx }, {
      kind: input.kind, title, body, files: refs.files, newFiles: input.files !== undefined, commits: refs.commits, commands: refs.commands,
      newCommits: input.commits !== undefined, newCommands: input.commands !== undefined, claim: input.evidence, notices: refs.notices,
      note: input.note ? cleanText(input.note) : undefined, provenance: [{ type: 'run', ref: ctx.runId }],
    });
  }

  async agentRetire(ctx: AgentContext, input: MemoryRetireToolInput): Promise<ProjectMemoryWriteResult> {
    const prior = this.agentEntry(ctx, input.id);
    if (prior.retired) return { entry: toEntry(prior, null), outcome: 'unchanged', notices: [] };
    if (prior.pinned) throw conflict('This memory entry is pinned by a person and is locked against agent edits.');
    if (input.expectedRevision !== undefined && input.expectedRevision !== prior.revision) throw conflict(`Memory entry changed; current revision is ${prior.revision}. Search again.`);
    this.screen(input.reason);
    this.checkWriteBudget(ctx.runId);
    const entry = this.commit({ projectId: prior.projectId, prior, op: 'retire', author: this.agentAuthor(ctx.session, ctx.runId), note: cleanText(input.reason),
      draft: { ...snapshotOf(prior), retired: true, humanVerified: false }, sessionId: ctx.session.id });
    return { entry: toEntry(entry, null), outcome: 'updated', notices: [] };
  }

  // ---- team replication ----------------------------------------------------------------------------------------

  /** Reconstructs the wire record of a locally stored revision. The signature is added by the sync layer. */
  toSyncRecord(row: RevisionRow, teamId: string, sharedProjectId: string, authorDeviceId: string, signature: string): ProjectMemorySyncRecord {
    return ProjectMemorySyncRecordSchema.parse({
      id: row.recordId, entryId: row.entryId, revision: row.revision, parentRevision: row.parentRevision, op: row.op, at: row.at, teamId, sharedProjectId,
      author: row.author, note: row.note, content: row.snapshot, createdAt: row.createdAt, authorDeviceId, signature,
      ...(row.lineage ? { lineage: row.lineage } : {}), ...(row.causalProof ? { causalProof: row.causalProof } : {}),
    });
  }

  private causalProofState(proof: ProjectMemoryCausalProof): 'valid' | 'pending' | 'invalid' {
    const parentRow = proof.parentId ? this.repo.entryRecordById(proof.parentId) : undefined;
    const parentProof = proof.parentId ? this.repo.causalProofFor(proof.parentId) : undefined;
    if (parentProof?.invalid) return 'invalid';
    if (proof.parentId && !parentProof?.valid && !parentRow) return 'pending';
    if (parentProof && !parentProof.valid) return 'pending';
    if (!proof.parentId) {
      const human = proof.authorKind === 'human';
      return proof.parentRevision === null && proof.revision === 1 && proof.epoch === (human ? 1 : 0)
        && proof.controlId === (human ? proof.recordId : null)
        && (human || (!proof.pinned && !proof.retired && !proof.humanVerified)) ? 'valid' : 'invalid';
    }
    const parentEntryId = parentProof?.proof.entryId ?? parentRow?.entryId;
    if (parentEntryId !== proof.entryId) return 'invalid';
    const parentRevision = parentProof?.proof.revision ?? parentRow!.revision;
    if (proof.parentRevision !== parentRevision || proof.revision !== parentRevision + 1) return 'invalid';
    // A legacy peer's signed lineage has no validated ancestry chain. Use it only for locally authored pre-proof rows;
    // remote legacy rows start a neutral causal baseline instead of importing a sender-asserted epoch/control id.
    const trustLocalLineage = parentRow && !parentRow.received;
    const parentEpoch = parentProof?.proof.epoch ?? (trustLocalLineage ? parentRow.lineage?.epoch ?? 0 : 0);
    const parentControl = parentProof?.proof.controlId ?? (trustLocalLineage ? parentRow.lineage?.controlId ?? null : null);
    const human = proof.authorKind === 'human';
    const expectedEpoch = parentEpoch + (human ? 1 : 0);
    const expectedControl = human ? proof.recordId : parentControl;
    if (proof.epoch !== expectedEpoch || proof.controlId !== expectedControl) return 'invalid';
    if (!human) {
      const parentPinned = parentProof?.proof.pinned ?? parentRow!.snapshot.pinned;
      const parentRetired = parentProof?.proof.retired ?? parentRow!.snapshot.retired;
      if (parentPinned || parentRetired || proof.pinned !== parentPinned || (proof.retired && proof.op !== 'retire') || proof.humanVerified) return 'invalid';
    }
    return 'valid';
  }

  private causalCompare(a: RevisionRow, b: RevisionRow): number {
    const ap = a.causalProof;
    const bp = b.causalProof;
    const al = ap ? { epoch: ap.epoch, controlId: ap.controlId } : a.lineage;
    const bl = bp ? { epoch: bp.epoch, controlId: bp.controlId } : b.lineage;
    if (al && bl) {
      if (al.epoch !== bl.epoch) return al.epoch - bl.epoch;
      const control = (al.controlId ?? '').localeCompare(bl.controlId ?? '');
      if (control) return control;
    }
    if (a.revision !== b.revision) return a.revision - b.revision;
    if ((a.author.kind === 'human') !== (b.author.kind === 'human')) return a.author.kind === 'human' ? 1 : -1;
    if (a.at !== b.at) return a.at.localeCompare(b.at);
    return a.recordId.localeCompare(b.recordId);
  }

  private makeHead(current: EntryRow | undefined, row: RevisionRow): EntryRow {
    const content = row.snapshot;
    const retiredNow = content.retired && !current?.retired;
    return {
      id: row.entryId, projectId: row.projectId, kind: content.kind, title: content.title, body: content.body, status: content.status,
      pinned: content.pinned, humanVerified: content.humanVerified, revision: row.revision, retired: content.retired,
      retiredAt: content.retired ? (retiredNow ? row.at : current?.retiredAt ?? row.at) : null,
      retiredByHuman: content.retired ? (retiredNow ? row.author.kind === 'human' : current?.retiredByHuman ?? false) : false,
      createdAt: current?.createdAt ?? row.at, updatedAt: row.at, author: current?.author ?? row.author, updatedBy: row.author,
      files: content.files, sources: content.sources, titleKey: titleKey(content.kind, content.title, content.body), bodyKey: bodyKey(content.body),
      headRecordId: row.recordId, headAt: row.at, originDeviceId: row.received ? row.authorDeviceId : null, stale: current?.stale ?? null,
    };
  }

  private promoteCausal(projectId: string, entryId: string): EntryRow | null {
    let changed = true;
    while (changed) {
      changed = false;
      for (const proof of this.repo.pendingCausalProofs(entryId)) {
        const state = this.causalProofState(proof);
        if (state === 'valid') { this.repo.markCausalValid(proof.recordId); changed = true; }
        else if (state === 'invalid') { this.repo.markCausalInvalid(proof.recordId); changed = true; }
      }
      for (const row of this.repo.pendingCausalRecords(entryId)) {
        const proof = row.causalProof;
        if (!proof) continue;
        const state = this.causalProofState(proof);
        if (state === 'valid') { this.repo.markCausalValid(row.recordId); changed = true; }
        else if (state === 'invalid') { this.repo.markCausalInvalid(row.recordId); changed = true; }
      }
    }
    const current = this.repo.getEntry(entryId);
    const candidates = this.repo.validRecords(entryId).filter((row) => row.causalProof || (!row.received && row.lineage));
    let winner = current ? this.repo.getRecord(current.headRecordId) : undefined;
    if (winner && winner.received && !winner.causalProof) winner = undefined;
    for (const candidate of candidates) if (!winner || this.causalCompare(candidate, winner) > 0) winner = candidate;
    if (!winner || winner.recordId === current?.headRecordId) return null;
    const next = this.makeHead(current, winner);
    this.repo.tx(() => {
      this.repo.upsertEntry(next);
      if (next.retired && !current?.retired) this.compactTombstones(projectId);
    });
    return next;
  }

  acceptCausalProof(projectId: string, proof: ProjectMemoryCausalProof): 'valid' | 'pending' {
    const state = this.causalProofState(proof);
    if (state === 'invalid') throw badRequest('The memory ancestry proof does not follow its parent control state.');
    this.repo.saveCausalProof(proof, state === 'valid');
    const head = this.promoteCausal(projectId, proof.entryId);
    if (head) { this.emit(head, 'update', 'peer'); void this.rescan(projectId, true); }
    return this.repo.causalProofFor(proof.recordId)?.valid ? 'valid' : 'pending';
  }

  resolvePendingCausal(projectId: string, entryId: string): EntryRow | null { return this.promoteCausal(projectId, entryId); }

  /**
   * Applies a verified team record to local state. The caller (sync layer) has already proven the sender, binding and signature;
   * this method re-validates the content, ordering and entry-level rules, and is idempotent for repeated records.
   */
  applyRemote(projectId: string, record: ProjectMemorySyncRecord): RemoteResult {
    this.project(projectId);
    if (this.repo.hasRecord(record.id)) return 'duplicate';
    if (Date.parse(record.at) > this.now() + SKEW_MS) throw badRequest('Memory record is dated in the future.');
    const content = record.content;
    if (record.op === 'create' && (record.revision !== 1 || record.parentRevision !== null)) throw badRequest('A create record must be revision 1.');
    if (record.author.kind === 'agent' && record.author.deviceId && record.author.deviceId !== record.authorDeviceId) throw badRequest('Agent author device does not match the signing device.');
    if (record.author.kind === 'human' && record.author.deviceId && record.author.deviceId !== record.authorDeviceId) throw badRequest('Author device does not match the signing device.');
    this.screen(content.title, content.body, record.note ?? undefined);
    const cleanTitle = cleanText(content.title);
    const cleanBody = cleanText(content.body);
    if (cleanTitle !== content.title || cleanBody !== content.body) throw badRequest('Memory record contains control characters.');
    for (const file of content.files) {
      const checked = checkMemoryPath(file.path);
      if (!checked.ok || checked.path !== file.path) throw badRequest('Memory record references an unsafe path.');
    }
    const current = this.repo.getEntry(record.entryId);
    if (current && current.projectId !== projectId) throw badRequest('Memory record belongs to a different project.');
    if (!current && this.repo.hasRetiredId(projectId, record.entryId)) return 'ignored';
    if (!current && !content.retired && this.repo.liveCount(projectId) >= (this.options.liveLimit ?? PROJECT_MEMORY_LIMITS.maxLiveEntries)) return 'ignored';
    let causalState: 'valid' | 'pending' | 'invalid' | 'legacy' = 'legacy';
    if (record.causalProof) {
      const proof = record.causalProof;
      if (proof.recordId !== record.id || proof.entryId !== record.entryId || proof.revision !== record.revision
        || proof.parentRevision !== record.parentRevision || proof.op !== record.op || proof.authorDeviceId !== record.authorDeviceId || proof.authorKind !== record.author.kind
        || ((proof.parentId === null) !== (record.op === 'create'))
        || proof.pinned !== content.pinned || proof.retired !== content.retired || proof.humanVerified !== content.humanVerified
        || !record.lineage || proof.parentId !== record.lineage.parentId || proof.controlId !== record.lineage.controlId || proof.epoch !== record.lineage.epoch) {
        throw badRequest('The causal proof does not describe this signed memory record.');
      }
      causalState = this.causalProofState(proof);
      if (causalState === 'invalid') throw badRequest('The memory ancestry proof does not follow its parent control state.');
    }
    const row: RevisionRow = {
      recordId: record.id, entryId: record.entryId, projectId, revision: record.revision, parentRevision: record.parentRevision, op: record.op, at: record.at,
      createdAt: record.createdAt, author: record.author, note: record.note, snapshot: content,
      changed: changedFields(current ? snapshotOf(current) : null, content), received: true, authorDeviceId: record.authorDeviceId, signature: record.signature,
      teamId: record.teamId, sharedProjectId: record.sharedProjectId, publishedAt: this.iso(),
      lineage: record.lineage, causalProof: record.causalProof, causalValid: causalState === 'valid',
    };
    this.repo.tx(() => {
      this.repo.insertRecord(row);
      this.repo.pruneRecords(record.entryId);
      this.repo.patchSyncState(projectId, { lastReceivedAt: this.iso() });
    });
    let applied: EntryRow | null = null;
    if (causalState === 'pending') return 'pending';
    if (record.causalProof) applied = this.promoteCausal(projectId, record.entryId);
    else {
      const newer = !current || outranks(record, current, this.repo.lineageFor(current.headRecordId));
      const blockedAgent = current && record.author.kind === 'agent' && (current.pinned || (current.retired && !content.retired));
      if (newer && !blockedAgent) {
        applied = this.makeHead(current, row);
        this.repo.tx(() => {
          this.repo.upsertEntry(applied!);
          if (applied!.retired && !current?.retired) this.compactTombstones(projectId);
        });
      }
    }
    const head: EntryRow | null = applied;
    if (head) {
      this.emit(head, record.op, 'peer');
      void this.rescan(projectId, true);
    }
    return 'applied';
  }

  /** Latest instant we hold for backfill requests, minus 1ms so a concurrent writer within the same millisecond is included. */
  backfillSince(projectId: string): string | null {
    const at = this.repo.latestRecordAt(projectId);
    return at ? new Date(Math.max(0, Date.parse(at) - 1)).toISOString() : null;
  }
}
