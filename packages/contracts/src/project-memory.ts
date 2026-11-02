import { z } from 'zod';
import { ProviderSchema } from './provider-config';

/**
 * Autonomous project memory. Entries are *data* recorded by earlier sessions and people; they are never instructions
 * and never grant permissions. Everything here is bounded so retrieval, history and sync stay cheap.
 */
export const PROJECT_MEMORY_LIMITS = {
  /** Live (active + stale) entries per project; further writes are refused until something is retired or merged. */
  maxLiveEntries: 500,
  /** Retired tombstones kept per project (minimal rows that make replay and resurrection checks possible). */
  maxTombstones: 2_000,
  /** Revisions retained per entry; older ones are compacted away (the first revision is always kept). */
  maxRevisionsPerEntry: 50,
  maxTitle: 120,
  maxBody: 1_500,
  maxFilesPerEntry: 8,
  maxPathLength: 300,
  maxCommitsPerEntry: 4,
  maxCommandsPerEntry: 4,
  /** Entries injected into a run, and the byte ceiling for the injected block. */
  contextMaxEntries: 8,
  contextMaxChars: 4_000,
  contextMaxPinned: 3,
  contextMaxStale: 2,
  /** Tool search results. */
  searchMaxResults: 10,
  listMaxLimit: 100,
  /** Agent writes allowed per run (guards against runaway loops). */
  maxAgentWritesPerRun: 25,
  /** Sanity ceiling for revision numbers and human-control epochs on received records (a signed record cannot claim an unbounded lead). */
  maxRevisionNumber: 1_000_000,
  /** Exact record ids one `want` request may ask for. */
  syncWantPerRequest: 20,
} as const;

export const ProjectMemoryKindSchema = z.enum(['decision', 'convention', 'gotcha', 'fact', 'verification']);
/**
 * `evidenced` is only ever assigned by the server and means its references were checked (a file at a recorded revision, a commit that exists,
 * a command that completed with exit 0 in the authoring run). It does not mean the text is true. The automatic `run` provenance reference never counts.
 */
export const ProjectMemoryStatusSchema = z.enum(['tentative', 'evidenced']);
/** `stale` is per device: a referenced file changed since the entry was written. `retired` entries are tombstones. */
export const ProjectMemoryLifecycleSchema = z.enum(['active', 'stale', 'retired']);
export const ProjectMemoryOpSchema = z.enum(['create', 'update', 'pin', 'retire', 'restore']);

export const ProjectMemoryAgentAuthorSchema = z.object({
  kind: z.literal('agent'), sessionId: z.string().min(1).max(100), runId: z.string().min(1).max(100),
  name: z.string().min(1).max(100), provider: ProviderSchema, model: z.string().min(1).max(150),
  accountId: z.string().max(100).nullable(), deviceId: z.string().max(100).nullable(),
}).strict();
export const ProjectMemoryHumanAuthorSchema = z.object({
  kind: z.literal('human'), displayName: z.string().min(1).max(120),
  accountId: z.string().max(100).nullable(), deviceId: z.string().max(100).nullable(),
}).strict();
export const ProjectMemoryAuthorSchema = z.discriminatedUnion('kind', [ProjectMemoryAgentAuthorSchema, ProjectMemoryHumanAuthorSchema]);

/** A project file the entry relies on. `revision` is the SHA-256 (hex, first 32 chars) the server computed — never agent-supplied. */
export const ProjectMemoryFileRefSchema = z.object({
  path: z.string().min(1).max(PROJECT_MEMORY_LIMITS.maxPathLength),
  revision: z.string().regex(/^[0-9a-f]{32}$/),
  /** Hash of the same file in the project root when the author worked in a different (isolated) worktree. */
  baseRevision: z.string().regex(/^[0-9a-f]{32}$/).nullable(),
  verifiedAt: z.string().datetime({ offset: true }),
}).strict();
/** Non-file provenance. Only references the server could verify are stored; `run` is automatic provenance and never certifies a claim. */
export const ProjectMemorySourceRefSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('commit'), ref: z.string().regex(/^[0-9a-f]{40,64}$/) }).strict(),
  z.object({ type: z.literal('run'), ref: z.string().min(1).max(100) }).strict(),
  z.object({ type: z.literal('command'), ref: z.string().min(1).max(300), runId: z.string().min(1).max(100), exitCode: z.literal(0) }).strict(),
]);

export const ProjectMemoryStaleSchema = z.object({
  since: z.string().datetime({ offset: true }), reason: z.string().max(300), paths: z.array(z.string().max(PROJECT_MEMORY_LIMITS.maxPathLength)).max(PROJECT_MEMORY_LIMITS.maxFilesPerEntry),
}).strict();

export const ProjectMemoryMatchSchema = z.object({
  score: z.number(), fields: z.array(z.enum(['title', 'body', 'path', 'kind'])).max(4),
}).strict();

export const ProjectMemoryEntrySchema = z.object({
  id: z.string().uuid(), projectId: z.string().min(1).max(100),
  kind: ProjectMemoryKindSchema,
  title: z.string().min(1).max(PROJECT_MEMORY_LIMITS.maxTitle), body: z.string().max(PROJECT_MEMORY_LIMITS.maxBody),
  status: ProjectMemoryStatusSchema, lifecycle: ProjectMemoryLifecycleSchema,
  pinned: z.boolean(),
  /** True once a person created, edited or re-verified the entry; any later agent edit clears it. */
  humanVerified: z.boolean(),
  revision: z.number().int().min(1),
  /** Stable identity of this entry's current signed revision; unlike revision, it never repeats after conflict resolution. */
  headRecordId: z.string().uuid(),
  createdAt: z.string().datetime({ offset: true }), updatedAt: z.string().datetime({ offset: true }),
  retiredAt: z.string().datetime({ offset: true }).nullable(),
  author: ProjectMemoryAuthorSchema, updatedBy: ProjectMemoryAuthorSchema,
  files: z.array(ProjectMemoryFileRefSchema).max(PROJECT_MEMORY_LIMITS.maxFilesPerEntry),
  sources: z.array(ProjectMemorySourceRefSchema).max(PROJECT_MEMORY_LIMITS.maxCommitsPerEntry + PROJECT_MEMORY_LIMITS.maxCommandsPerEntry + 1),
  stale: ProjectMemoryStaleSchema.nullable(),
  /** `local` when last written on this device, otherwise the id of the teammate device that sent it. */
  origin: z.object({ local: z.boolean(), deviceId: z.string().max(100).nullable() }).strict(),
  /** Present only on search results (`q` given). */
  match: ProjectMemoryMatchSchema.nullable(),
}).strict();

export const ProjectMemoryRevisionSnapshotSchema = z.object({
  kind: ProjectMemoryKindSchema, title: z.string().min(1).max(PROJECT_MEMORY_LIMITS.maxTitle), body: z.string().max(PROJECT_MEMORY_LIMITS.maxBody),
  status: ProjectMemoryStatusSchema, pinned: z.boolean(), retired: z.boolean(), humanVerified: z.boolean(),
  files: z.array(ProjectMemoryFileRefSchema).max(PROJECT_MEMORY_LIMITS.maxFilesPerEntry),
  sources: z.array(ProjectMemorySourceRefSchema).max(PROJECT_MEMORY_LIMITS.maxCommitsPerEntry + PROJECT_MEMORY_LIMITS.maxCommandsPerEntry + 1),
}).strict();

export const ProjectMemoryRevisionSchema = z.object({
  id: z.string().uuid(), entryId: z.string().uuid(), revision: z.number().int().min(1),
  parentRevision: z.number().int().min(1).nullable(), op: ProjectMemoryOpSchema,
  at: z.string().datetime({ offset: true }), author: ProjectMemoryAuthorSchema, note: z.string().max(300).nullable(),
  snapshot: ProjectMemoryRevisionSnapshotSchema,
  /** Fields that differ from the parent revision. */
  changed: z.array(z.enum(['kind', 'title', 'body', 'status', 'pinned', 'retired', 'files', 'sources'])).max(8),
  /** True when this revision was received from a teammate device. */
  received: z.boolean(),
  /** True when two devices wrote the same revision number concurrently and this one did not become the head. */
  superseded: z.boolean(),
}).strict();

export const ProjectMemorySharingSchema = z.object({
  /** True when this project is bound to a team shared project; memory then replicates automatically. */
  shared: z.boolean(),
  teamId: z.string().uuid().nullable(), sharedProjectId: z.string().uuid().nullable(),
  localDeviceId: z.string().uuid().nullable(),
  /** Mutually linked, active teammate devices that can currently receive memory. */
  peerCount: z.number().int().min(0),
  /** Local revisions not yet accepted by the encrypted transport outbox. */
  unpublished: z.number().int().min(0),
  lastBackfillAt: z.string().datetime({ offset: true }).nullable(),
  lastReceivedAt: z.string().datetime({ offset: true }).nullable(),
  error: z.string().max(300).nullable(),
}).strict();

export const ProjectMemoryCountsSchema = z.object({
  live: z.number().int().min(0), stale: z.number().int().min(0), retired: z.number().int().min(0),
  pinned: z.number().int().min(0), tentative: z.number().int().min(0), evidenced: z.number().int().min(0),
}).strict();

export const ProjectMemoryListResponseSchema = z.object({
  entries: z.array(ProjectMemoryEntrySchema).max(PROJECT_MEMORY_LIMITS.listMaxLimit),
  /** Matching entries before paging. */
  total: z.number().int().min(0),
  nextCursor: z.string().max(100).nullable(),
  counts: ProjectMemoryCountsSchema,
  sharing: ProjectMemorySharingSchema,
  limits: z.object({ maxLiveEntries: z.number().int(), maxRevisionsPerEntry: z.number().int() }).strict(),
}).strict();

export const ProjectMemoryEntryDetailSchema = z.object({
  entry: ProjectMemoryEntrySchema,
  /** Newest first, at most 20; use the history endpoint for more. */
  history: z.array(ProjectMemoryRevisionSchema).max(20), historyTruncated: z.boolean(),
}).strict();

export const ProjectMemoryHistoryResponseSchema = z.object({
  entryId: z.string().uuid(), revisions: z.array(ProjectMemoryRevisionSchema).max(100), nextCursor: z.string().max(100).nullable(),
}).strict();

export const ProjectMemoryWriteResultSchema = z.object({
  entry: ProjectMemoryEntrySchema,
  /** `unchanged`: nothing differed. `merged`: an equivalent entry already existed, so it was updated instead of duplicated. */
  outcome: z.enum(['created', 'updated', 'merged', 'unchanged']),
  /** Plain-language notes, e.g. a path that was ignored or evidence that was downgraded to tentative. */
  notices: z.array(z.string().max(300)).max(10),
}).strict();

/** One block of memory that was placed in a run's context. */
export const ProjectMemoryInjectionSchema = z.object({
  runId: z.string().min(1).max(100), sessionId: z.string().min(1).max(100), at: z.string().datetime({ offset: true }),
  query: z.string().max(300),
  entries: z.array(z.object({
    id: z.string().uuid(), revision: z.number().int().min(1), title: z.string().max(PROJECT_MEMORY_LIMITS.maxTitle),
    kind: ProjectMemoryKindSchema, lifecycle: z.enum(['active', 'stale']), pinned: z.boolean(), reason: z.enum(['pinned', 'relevant', 'recent', 'stale']),
  }).strict()).max(PROJECT_MEMORY_LIMITS.contextMaxEntries),
  chars: z.number().int().min(0), truncated: z.boolean(),
}).strict();
export const ProjectMemoryInjectionsResponseSchema = z.object({
  injections: z.array(ProjectMemoryInjectionSchema).max(50),
}).strict();
/** What a run started now with `query` would receive, including the exact text block. */
export const ProjectMemoryContextPreviewSchema = z.object({
  injection: ProjectMemoryInjectionSchema.omit({ runId: true, sessionId: true }), text: z.string().max(PROJECT_MEMORY_LIMITS.contextMaxChars + 2_000),
}).strict();

/** ---- HTTP inputs (human) ---- */
const KindInput = ProjectMemoryKindSchema;
const TitleInput = z.string().trim().min(3).max(PROJECT_MEMORY_LIMITS.maxTitle);
const BodyInput = z.string().trim().min(1).max(PROJECT_MEMORY_LIMITS.maxBody);
const PathInput = z.string().trim().min(1).max(PROJECT_MEMORY_LIMITS.maxPathLength);
const FilesInput = z.array(PathInput).max(PROJECT_MEMORY_LIMITS.maxFilesPerEntry);

export const CreateProjectMemorySchema = z.object({
  kind: KindInput, title: TitleInput, body: BodyInput, files: FilesInput.optional(), pinned: z.boolean().optional(),
}).strict();
export type CreateProjectMemoryInput = z.infer<typeof CreateProjectMemorySchema>;

/** Optimistic concurrency: `expectedRevision` must equal the entry's current revision or the request fails with 409. */
export const PatchProjectMemorySchema = z.object({
  expectedRevision: z.number().int().min(1),
  expectedHeadId: z.string().uuid(),
  kind: KindInput.optional(), title: TitleInput.optional(), body: BodyInput.optional(),
  /** Replaces the file references; the server re-hashes them. Omit to keep, pass [] to clear. */
  files: FilesInput.optional(),
  pinned: z.boolean().optional(),
  /** `retired` writes a tombstone; `active` restores a retired entry or re-verifies a stale one against current files. */
  lifecycle: z.enum(['active', 'retired']).optional(),
  note: z.string().trim().max(300).optional(),
}).strict().refine((value) => Object.keys(value).some((key) => key !== 'expectedRevision' && key !== 'expectedHeadId' && key !== 'note' && value[key as keyof typeof value] !== undefined),
  'Supply a field to change');
export type PatchProjectMemoryInput = z.infer<typeof PatchProjectMemorySchema>;

const csvBool = z.enum(['true', 'false']).transform((value) => value === 'true');
export const ProjectMemoryQuerySchema = z.object({
  q: z.string().trim().max(300).optional(),
  kind: KindInput.optional(), status: ProjectMemoryStatusSchema.optional(), pinned: csvBool.optional(),
  /** `live` (default) = active + stale; `retired` = tombstones; `all` = everything. */
  include: z.enum(['live', 'retired', 'all']).default('live'),
  limit: z.coerce.number().int().min(1).max(PROJECT_MEMORY_LIMITS.listMaxLimit).default(50),
  cursor: z.string().max(100).optional(),
}).strict();
export type ProjectMemoryQuery = z.infer<typeof ProjectMemoryQuerySchema>;

export const ProjectMemoryHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().max(100).optional(),
}).strict();
export const ProjectMemoryPreviewQuerySchema = z.object({ query: z.string().trim().max(300).default('') }).strict();

/** ---- Agent MCP tool inputs (author identity always comes from the authenticated run, never from these) ---- */
const SHA = z.string().regex(/^[0-9a-f]{40,64}$/i);
export const MemoryRememberToolSchema = z.object({
  kind: KindInput, title: TitleInput, body: BodyInput,
  files: FilesInput.optional().describe('Project-relative files this entry relies on. Mingle hashes them itself.'),
  commits: z.array(SHA).max(PROJECT_MEMORY_LIMITS.maxCommitsPerEntry).optional(),
  commands: z.array(z.string().trim().min(1).max(300)).max(PROJECT_MEMORY_LIMITS.maxCommandsPerEntry).optional()
    .describe('Commands you ran in THIS run that support the entry; kept only if they exited 0.'),
  evidence: z.enum(['tentative', 'evidenced']).default('tentative')
    .describe('Claim `evidenced` only when you verified it; Mingle downgrades it unless a reference checks out.'),
}).strict();
export const MemorySearchToolSchema = z.object({
  query: z.string().trim().max(300).optional(),
  kind: KindInput.optional(), includeStale: z.boolean().default(true),
  limit: z.number().int().min(1).max(PROJECT_MEMORY_LIMITS.searchMaxResults).default(5),
}).strict();
export const MemoryUpdateToolSchema = z.object({
  id: z.string().uuid(), expectedRevision: z.number().int().min(1).optional(), expectedHeadId: z.string().uuid().optional(),
  kind: KindInput.optional(), title: TitleInput.optional(), body: BodyInput.optional(),
  files: FilesInput.optional(), commits: z.array(SHA).max(PROJECT_MEMORY_LIMITS.maxCommitsPerEntry).optional(),
  commands: z.array(z.string().trim().min(1).max(300)).max(PROJECT_MEMORY_LIMITS.maxCommandsPerEntry).optional(),
  evidence: z.enum(['tentative', 'evidenced']).optional(),
  note: z.string().trim().max(300).optional(),
}).strict();
export const MemoryRetireToolSchema = z.object({
  id: z.string().uuid(), reason: z.string().trim().min(3).max(300), expectedRevision: z.number().int().min(1).optional(), expectedHeadId: z.string().uuid().optional(),
}).strict();

/** ---- Team replication (carried inside the existing authenticated, encrypted device transport) ---- */
export const PROJECT_MEMORY_MESSAGE_KINDS = ['projectmemory.record', 'projectmemory.sync.request', 'projectmemory.sync.response'] as const;

/**
 * Signed causal metadata. `parentId` is the head this revision was written on top of. A *human control version* starts at every record
 * written by a person (pin, unpin, retire, restore or edit); `epoch` counts those steps and `controlId` is the human record the author had
 * seen last (for a person's own record: the control it replaces). Agents inherit the control they saw and cannot create a new one.
 * A device therefore ranks a record by `(epoch, control version)` before its revision counter, so an agent's extra offline revisions can
 * never outrank a person's decision made on the same base, while an agent edit written *after* a person's unpin or restore still wins.
 * Records signed before this field existed carry none and retain the legacy conflict tie-break behavior.
 */
export const ProjectMemoryLineageSchema = z.object({
  parentId: z.string().uuid().nullable(), controlId: z.string().uuid().nullable(),
  epoch: z.number().int().min(0).max(PROJECT_MEMORY_LIMITS.maxRevisionNumber),
}).strict();
export type ProjectMemoryLineage = z.infer<typeof ProjectMemoryLineageSchema>;

/** Compact, independently signed ancestry proof retained even when its revision body is pruned. */
export const ProjectMemoryCausalProofSchema = z.object({
  recordId: z.string().uuid(), entryId: z.string().uuid(), parentId: z.string().uuid().nullable(),
  parentRevision: z.number().int().min(1).max(PROJECT_MEMORY_LIMITS.maxRevisionNumber).nullable(),
  revision: z.number().int().min(1).max(PROJECT_MEMORY_LIMITS.maxRevisionNumber),
  op: ProjectMemoryOpSchema, authorKind: z.enum(['human', 'agent']), authorDeviceId: z.string().uuid(),
  controlId: z.string().uuid().nullable(), epoch: z.number().int().min(0).max(PROJECT_MEMORY_LIMITS.maxRevisionNumber),
  pinned: z.boolean(), retired: z.boolean(), humanVerified: z.boolean(), signature: z.string().min(80).max(100),
}).strict();
export type ProjectMemoryCausalProof = z.infer<typeof ProjectMemoryCausalProofSchema>;

export const ProjectMemorySyncRecordSchema = z.object({
  id: z.string().uuid(), entryId: z.string().uuid(), revision: z.number().int().min(1).max(PROJECT_MEMORY_LIMITS.maxRevisionNumber),
  parentRevision: z.number().int().min(1).max(PROJECT_MEMORY_LIMITS.maxRevisionNumber).nullable(),
  op: ProjectMemoryOpSchema, at: z.string().datetime({ offset: true }),
  teamId: z.string().uuid(), sharedProjectId: z.string().uuid(),
  author: ProjectMemoryAuthorSchema, note: z.string().max(300).nullable(),
  content: ProjectMemoryRevisionSnapshotSchema,
  createdAt: z.string().datetime({ offset: true }),
  authorDeviceId: z.string().uuid(), signature: z.string().min(80).max(100),
  /** Absent only on records signed by an older build. When present it is covered by the signature. */
  lineage: ProjectMemoryLineageSchema.optional(),
  causalProof: ProjectMemoryCausalProofSchema.optional(),
}).strict();
export type ProjectMemorySyncRecord = z.infer<typeof ProjectMemorySyncRecordSchema>;

export const ProjectMemorySyncRequestSchema = z.object({
  sharedProjectId: z.string().uuid(), requestId: z.string().uuid(), since: z.string().datetime({ offset: true }).nullable(),
  /** Fetch exactly these records (missing ancestors of records already held) and nothing else; `since` and `cursors` are then ignored. */
  want: z.array(z.string().uuid()).min(1).max(PROJECT_MEMORY_LIMITS.syncWantPerRequest).optional(),
}).strict();
export const ProjectMemorySyncResponseSchema = z.object({
  sharedProjectId: z.string().uuid(), requestId: z.string().uuid(),
  batchIndex: z.number().int().min(0).max(199), batchCount: z.number().int().min(1).max(200),
  /** True on the final batch when the responder has more records beyond the per-request ceiling. */
  more: z.boolean(), records: z.array(ProjectMemorySyncRecordSchema).max(100),
  proofs: z.array(ProjectMemoryCausalProofSchema).max(100).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.batchIndex >= value.batchCount) ctx.addIssue({ code: 'custom', path: ['batchIndex'], message: 'Batch index must be below batch count.' });
});

export type ProjectMemoryKind = z.infer<typeof ProjectMemoryKindSchema>;
export type ProjectMemoryStatus = z.infer<typeof ProjectMemoryStatusSchema>;
export type ProjectMemoryLifecycle = z.infer<typeof ProjectMemoryLifecycleSchema>;
export type ProjectMemoryOp = z.infer<typeof ProjectMemoryOpSchema>;
export type ProjectMemoryAuthor = z.infer<typeof ProjectMemoryAuthorSchema>;
export type ProjectMemoryFileRef = z.infer<typeof ProjectMemoryFileRefSchema>;
export type ProjectMemorySourceRef = z.infer<typeof ProjectMemorySourceRefSchema>;
export type ProjectMemoryEntry = z.infer<typeof ProjectMemoryEntrySchema>;
export type ProjectMemoryRevision = z.infer<typeof ProjectMemoryRevisionSchema>;
export type ProjectMemoryRevisionSnapshot = z.infer<typeof ProjectMemoryRevisionSnapshotSchema>;
export type ProjectMemorySharing = z.infer<typeof ProjectMemorySharingSchema>;
export type ProjectMemoryCounts = z.infer<typeof ProjectMemoryCountsSchema>;
export type ProjectMemoryListResponse = z.infer<typeof ProjectMemoryListResponseSchema>;
export type ProjectMemoryEntryDetail = z.infer<typeof ProjectMemoryEntryDetailSchema>;
export type ProjectMemoryHistoryResponse = z.infer<typeof ProjectMemoryHistoryResponseSchema>;
export type ProjectMemoryWriteResult = z.infer<typeof ProjectMemoryWriteResultSchema>;
export type ProjectMemoryInjection = z.infer<typeof ProjectMemoryInjectionSchema>;
export type ProjectMemoryInjectionsResponse = z.infer<typeof ProjectMemoryInjectionsResponseSchema>;
export type ProjectMemoryContextPreview = z.infer<typeof ProjectMemoryContextPreviewSchema>;
export type MemoryRememberToolInput = z.input<typeof MemoryRememberToolSchema>;
export type MemorySearchToolInput = z.input<typeof MemorySearchToolSchema>;
export type MemoryUpdateToolInput = z.input<typeof MemoryUpdateToolSchema>;
export type MemoryRetireToolInput = z.input<typeof MemoryRetireToolSchema>;
export interface MemoryMcpConnection { url: string; token: string }
