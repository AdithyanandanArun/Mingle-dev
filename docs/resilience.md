# Recovery and resilience contract

Mingle's resilience layer preserves what the host actually knows about a session or group. A checkpoint references workspace state; it does not claim that edits, tasks or acceptance criteria completed. Native provider conversations remain owned by their providers.

## Autonomy and limits

`AutonomyConfig` supports `supervised`, `balanced` and `extended`; new group defaults are balanced. For local-only groups, `extended` is the Full-access switch. For cross-device groups, the canonical switch is the host team setting `permissionLevel: 'full-access'`; owner consent must independently grant that level. Group defaults use 80 turns (maximum 10,000). New groups receive that default, while stored per-group values such as 16 remain unchanged. The optional `emergencyTurnLimit` has three distinct meanings:

- Omitted: use that group's saved `maxTurns` ceiling.
- `null`: disable the configured turn ceiling. Full access still uses its hard safety ceiling of 200 turns.
- A number from 2 to 10,000: use this explicit effective ceiling instead of `maxTurns`.

Task finish criteria preserve whether acceptance conditions were explicit or derived and can require evidence or human review. Full-access requests extend their durable per-request turn threshold when exhausted, up to `min(4 × configured effective limit, 200)`; a null configured limit uses the hard 200-turn ceiling. Message hops can extend above the schema's group maximum of 12 to an internal ceiling of 24. Every extension emits `group.budget.auto-extended`; reaching either hard ceiling pauses and retains queued work. Group settings and usage are never reset. Supervised and balanced groups retain their configured budget holds.

For a local extended group, a dispatched member run uses native Full-access only when the provider/model advertises that policy; the saved per-session policy is not rewritten. If the provider cannot grant it, the run keeps its saved policy. For cross-device teams, the owner runtime remains the native approval boundary: the host auto-approves a request only while both team permission and that agent's owner consent grant Full access.

Fallback is a group-level `GroupRecoveryPolicy`, not a group default. `automaticFallback` defaults false for supervised/balanced groups. In Full access, it is effectively enabled because the stored false value also represents the legacy/default setting and does not distinguish an explicit opt-out. A configured worker or lead fallback is tried first; otherwise the group selects an eligible available member, preferring a different provider and lower queued/running load while avoiding the orchestrator for worker tasks unless it is the only eligible member. Cross-device candidates require a current Full-access consent and an online owner device. Known same quota-pool exhaustion, provider cooldown, held/removed members, conflicting assignment scope, busy sessions, or permission mismatch exclude a candidate. Full access is allowed to use a different provider when quota-pool identity is unreported; this does not assert that its quota is available. In supervised/balanced groups, `allowUnverifiedQuotaFallback` remains the explicit advanced opt-in for one attempt to a configured cross-provider fallback when the source quota pool is unknown.

Quota exhaustion and temporary rate limits create a durable provider cooldown until the provider's reported `retryAt`, or 15 minutes when no reset is reported. Migration 26 stores the originating group/member, provider, reason, deadline and creation time. The active cooldown is loaded at startup, and expired rows are pruned during startup and health/routing reads. `getMemberHealth(groupId)` exposes the same per-member `ok`, `cooldown`, `stalled` or `failed` state, with the cooldown deadline and a short reason.

Full-access worker reassignment preserves the assignment ID, task, scope and acceptance criteria, and is bounded to two automatic fallbacks per task. A replacement receives a bounded failure/partial-text note and work reference: local workers include their source worktree branch and HEAD plus an instruction to cherry-pick or merge the commit; cross-device workers include the permanent `origin/mingle/<handle>/work` branch and latest known commit plus a fetch/continue instruction. An uncertain checkpoint is retained as context for inspection rather than stopping for human acknowledgement. If no eligible member remains, the group pauses with a transcript blocker. Coordinator failure uses the configured lead fallback or the same availability/load selection.

Running deliveries with no provider-message, tool-output or authenticated team heartbeat/activity progress for 10 minutes are marked stalled by one 30-second service sweep. Pending approvals and provider questions are excluded. Full access interrupts through the normal local/remote path, records an `unknown` stalled failure, retries once on the same member, then applies the bounded fallback policy. Supervised/balanced groups keep the run for human action and expose the stalled state. `group.delivery.auto-fallback`, `group.delivery.stalled` and `group.member.cooldown` events contain IDs, failure kind and concise reason only; automatic actions also write one short group-transcript status message.

## Durable data and bounds

Migrations 11, 12, 24, 25 and 26 are additive. Version 11 introduces:

- Group `autonomy_policy`, `recovery_policy`, `recovery_state` and monotonically increasing `coordinator_epoch`; each claimed delivery records the epoch under which it was dispatched.
- `session_checkpoints`, versioned and bounded to 64 KiB, at most 20 per session.
- `session_failures`, addressable by `runId`, retaining the most recent 20 per session. Resolution marks a failure as no longer current but preserves its per-run record for old deliveries and repeat-failure analysis. A failure record is saved before the scheduler's run-finished callback.
- `group_recovery_actions`, idempotent by `(group_id, idempotency_key)`.
- `group_recovery_checkpoints`, for durable batch acknowledgement/Ask me checkpoints.
- `group_assignment_milestones`, retaining acceptance provenance and a bounded reference to host evidence.
- `group_stall_evidence`, retaining fingerprinted evidence/counters rather than transcripts.

Version 25 adds per-request `auto_turn_limit` and `auto_max_hops` columns. These retain Full-access budget extensions without rewriting saved group defaults.

Version 26 adds `group_provider_cooldowns`, a small durable provider/member cooldown table with an expiry index.

Version 12 conditionally adds `session_failures.resolved_at` when absent, preserving compatibility with databases already at version 11 as originally shipped, and adds `group_recovery_deliveries` as a durable one-to-one source/successor link. The optional `GroupDelivery.recoveredByDeliveryId` snapshot field identifies a superseded failed delivery's successor. `GroupRecoveryState.acknowledgedCheckpointId` identifies the durable group checkpoint (not a provider session checkpoint), and coordinator replacement can include a `requestId` to target a Cowork planner lease.

Checkpoints include an objective reference, assigned task titles/descriptions/acceptance criteria/status, actual worktree path/branch/HEAD/dirty paths, group artifact references, pending approval summaries, bounded errors and uncertain tool summaries. They never include approval inputs, tool input/output, complete source files, credentials, or full unbounded message transcripts. Git uses argv arrays with noninteractive, bounded status/metadata commands. Missing Git data yields `statusKnown: false` and a notice; it is not represented as a clean state. Dirty paths cap at 500 and the whole serialized checkpoint caps at 64 KiB. Every checkpoint carries schema `version: 1`. A restart captures a checkpoint for each session recovered from a running/waiting state; an interrupted compaction with no persisted run is marked uncertain and is never resumed. Shutdown drains outstanding checkpoint captures before SQLite closes.

Migration 24 adds `session_resume_queue`, keyed by the interrupted run ID. Standalone local sessions with a persisted active run are queued on an unclean restart and during orderly application close. `autoResumeOnRestart` defaults to `true`; when enabled, Mingle waits for provider detection after the server is listening, then starts at most two continuations at a time. A run older than 24 hours, an archived/missing session, an active session, an unavailable provider or an automatic-resume attempt already made is skipped with a `session.run.resume-skipped` event. Each interrupted run has at most one automatic attempt. The session message is retained, pending approvals are still denied on shutdown, and no prior approval is carried into the new run. A saved native provider-session ID is used by the normal runtime; when it is absent, the continuation includes the last saved user request as bounded context. Tasks linked to the old run are passed through the normal run/task linkage. An interrupted execution plan continues through the existing plan execution path only when its exact revision had already been approved; no unapproved plan is executed. `session.run.resumed` records the old and new run IDs. The user can disable automatic continuation in Settings → General.

Native compaction without a persisted active run remains uncertain and is never resumed automatically. Group member sessions and team proxy sessions are excluded from raw session continuation. When `autoResumeOnRestart` is enabled, an unpaused group of any permission level queues at most one same-member continuation for each delivery that was running at shutdown, subject to the 24-hour age limit and one-attempt bound. The continuation preserves the request/task and directs the agent to inspect its persistent workspace and recovery checkpoint before repeating possible side effects. Provider availability is refreshed after the server listens before queued group turns are released. This resumes work that was already dispatched; native approvals still expire and are asked again, and supervised/balanced failure checkpoints and budget holds still wait for human acknowledgement. When the setting is disabled, interrupted group work stays paused.

For cross-device teams, the host never continues a proxy session as a local provider. When restart recovery has queued a continuation for a remote delivery, the host interrupts the old owner-device turn and holds the proxy slot until the owner reports interruption or times out, then dispatches one fresh continuation to the same agent. The owner's persistent worktree retains partial work. No new fallback is selected.

Failure records retain a stable provider failure kind, provider code when safely reported, retryability, dispatch certainty, outcome uncertainty, continuation safety, optional known non-secret quota pool, a bounded retry time and redacted visible reason. `retryable: true` does not mean replay is safe. `safeToRetry: true` is required as positive proof for the provider-proven non-dispatch retry path; that path retains its bounded retry time. In Full access, a retryable failure not already on that proven non-dispatch path, or an uncertain outcome, gets one recovery attempt: Mingle captures a native checkpoint, durably acknowledges a group checkpoint and queues a continuation with an explicit inspect-before-retry note. This is limited by `MAX_SAFE_RETRIES`; a continuation is not retried again. Supervised/balanced groups keep the checkpoint acknowledgement gate. HTTP 429 alone is never classified as quota exhaustion. Output truncation is not successful completion.

## Recovery API

`RecoveryService` is constructed with the shared `Store` and exposes:

```ts
capture(sessionId: string, reason: string, runId?: string): Promise<RecoveryCheckpoint>
latest(sessionId: string): RecoveryCheckpoint | null
recordFailure(sessionId: string, runId: string, failure: ProviderFailure): void
failure(sessionId: string): ProviderFailure | null
failureForRun(runId: string): ProviderFailure | null
clearFailure(sessionId: string): void
```

`capture` verifies optional run ownership, inspects Git without modifying the worktree or index, and persists only bounded references. Failure and checkpoint state are independent: a new checkpoint never clears or overwrites a failure. `clearFailure(sessionId)` resolves current visibility while retaining each historical failure addressable through `failureForRun(runId)`.

### HTTP routes

All paths are under `/api`:

| Route | Request | Response |
| --- | --- | --- |
| `GET /sessions/:id/recovery` | — | `{ checkpoint: RecoveryCheckpoint \| null, failure: ProviderFailure \| null }` |
| `POST /sessions/:id/checkpoints` | `{ reason: string (1–200), runId?: string }` | `RecoveryCheckpoint` (201) |
| `POST /groups/:id/recovery` | `RecoveryActionRequest` | `RecoveryActionResult` |
| `POST /sessions/:id/messages/:messageId/retry` | `{}` | `{ accepted: true }` (202) |
| `POST /sessions/:id/compact` | `{ operationId?: string (1–100) }` | `ContextCompactionResult` |
| `POST /sessions/:id/compact/interrupt` | `{ operationId: string (1–100) }` | `{ interrupted: boolean }` |

The strict recovery action union is idempotency keyed and supports retry with an optional approach note, delivery reassign to a selected existing member, coordinator replacement, Ask me/pause, acknowledgement of a specific durable checkpoint, and explicit resume. Group recovery calls `GroupService.recoverAction`; startup's `recover()` remains distinct. Stale action state is revalidated in the group service, not trusted from a renderer snapshot.

Provider-switch retry accepts only the latest failed user message belonging to that session. The server creates fresh attachment rows and private file copies, retains the original content and context references, checks the current provider's attachment support, and starts a normal run through the session's current provider (including its pending provider handoff). Missing files are reported by name; a stale message or wrong session is rejected. Attachment count, total-size, per-file, provider image and native-command limits still apply. Group deliveries continue through group recovery instead.

Startup does not call the general group resume action. Eligible running group deliveries use a separate one-attempt startup continuation path that does not acknowledge unrelated pending checkpoints or clear member holds; queued work starts only after provider discovery. Other interrupted work remains visibly paused. Team proxy sessions are never continued as ordinary local sessions; the owner device remains the only provider-runtime owner, and the host redispatches only after stopping the stale owner turn. Each started restart successor records `group.delivery.resumed`.

## Coordinator fencing and delivery semantics

Lead replacement is one SQLite transaction that updates the group's coordinator member/role, rewrites actionable request planner authority, and increments `coordinator_epoch`. Every claimed delivery snapshots that epoch. Team tool operations revalidate role and epoch when invoked and after any awaited artifact/path verification. Stale leads cannot dispatch. Independent workers already running are not invalidated merely because the lead is unavailable; only new lead-dependent dispatch pauses. Recovery actions and duplicate message deliveries use durable idempotency keys. A resume or replacement never clears a worker's cleanup lock, abandons dirty edits, merges branches or changes task acceptance.

## Manual context compaction

`SessionRuntime.compact(sessionId, operationId?)` targets one session. It synchronously reserves the same active/cleanup lock used by provider runs before its first `await`; `isActive()` and resource counts include the compaction. Session bootstrap is marked `running` and restored to its prior status/error after native cleanup, making busy state visible across windows without clearing existing failure history. A same-session run/approval/cleanup conflict returns 409. `POST /sessions/:id/compact/interrupt` with the same bounded operation ID cancels only that compaction, so a stale Stop cannot interrupt a subsequent run or compaction. General interrupt/shutdown also abort native work and keep the lock until native cleanup settles. Before native compaction, the runtime requires a durable recovery checkpoint; if capture fails, native history is left untouched and the result is a visible failure. It rechecks session/project visibility and provider configuration after that await. It records durable `session.compaction.started|completed|failed|unsupported` events, returns the pre-compaction checkpoint ID, and tries a post-operation checkpoint without allowing checkpoint errors to change the native operation's result.

Native support is capability-based:

- **Codex app-server:** `thread/compact/start`; success follows the completed native `contextCompaction` item.
- **Claude Agent SDK:** resume and issue `/compact` only when `supportedCommands()` advertises the built-in command; verify the SDK result and compaction boundary.
- **OpenCode ACP:** use the native local server's `POST /session/:id/summarize` only when the current native session/provider/model are bound and the server confirms success.
- **Antigravity ACP:** explicitly unsupported; ACP compaction updates alone are reports, not client-requested native compaction operations.

Unavailable/unsafe capabilities return `unsupported` or `failed`; Mingle does not send a generic `/compact` prompt, invent a summary, run ordinary tools, bypass the saved permission policy, or silently create a replacement native conversation. See the provider worker's dated research note for primary sources and observed limits.
