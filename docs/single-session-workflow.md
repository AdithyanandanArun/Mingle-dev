# Autonomous single-session work (implementation interface)

A standalone root session can explicitly start a bounded goal. Permissions remain the selected native provider policy; autonomous follow-through never changes provider, model, effort, permission level or worktree. The agent uses its existing conversation, progress checklist, tools and project memory. Human input, failed/uncertain dispatches, explicit pause/stop and exhausted limits remain visible boundaries.

Contracts live in `packages/contracts/src/session-workflow.ts`. `Bootstrap.workflows` is optional for compatibility. Each snapshot holds a unique workflow id, version, session/task ids, goal, running/paused/stopped/completed state, reason/summary, limits and counters, pinned configuration, current/last run ids and a persisted deadline. The default is eight total turns, four hours and two no-progress continuations. Explicit resume may grant more turns/time within the hard contract limits.

Local, existing Host/Origin-guarded routes:

- `GET /api/sessions/:id/workflow` → `{ workflow: SessionWorkflow | null }`.
- `POST /api/sessions/:id/workflow` → `SessionWorkflow`; body is `StartSessionWorkflowSchema` (goal, optional limits, attachments and context references). Reuses the native runtime and attachment path; rejects active/busy, grouped, child, proxy, archived and unsupported sessions.
- `POST .../workflow/pause` and `POST .../workflow/stop` → `SessionWorkflow`; require `{ expectedVersion }`.
- `POST .../workflow/resume` → `SessionWorkflow`; requires `{ expectedVersion, additionalTurns?, extendMinutes? }`. Check the snapshot version, current eligibility/configuration and runtime lock before starting.

A run-scoped `mingle_workflow_finish` tool is exposed through the existing progress MCP connection only for an active workflow invocation. It accepts `{ outcome: 'complete'|'blocked'|'needs_human', summary }`, derives its workflow/session/run identity on the server, and records a pending report. Applying a successful completion waits for the native turn to end. It is an agent-reported result, not an independent certification of checks, integration or publication. The goal task remains in Review; ordinary task acceptance is unchanged.

The service owns durable workflow/run bindings and schedules continuations at a runtime idle edge after provider cleanup and queued-input handling. It does not infer success from assistant prose or a native turn ending. Unreported outcomes receive one bounded verification turn; repeated missing reports, repeated no-progress turns, denied approvals, unanswered questions, provider refusal/failure, configuration changes and budget exhaustion pause with a useful reason. In-flight subagent results are awaited without polling; user-queued input has priority. Pause/Stop must also fence late subagent wakeups and stale continuation callbacks. Explicit human sends remain possible.

Restart preserves the goal and history, pauses the workflow, and requires explicit Resume after inspecting partial work. `SessionResumeService` must skip workflow-owned runs, avoiding a second automatic recovery owner. Native permissions, approvals and context-compaction rules stay intact. No automatic retry of failures with uncertain side effects is added.

Intended service seam for parent integration: constructor options `{ store, runtime, tasks, recovery, groups }`; methods `get(sessionId)`, `list()`, `start(sessionId, parsedInput)`, `pause(sessionId, expectedVersion)`, `stop(sessionId, expectedVersion)`, `resume(sessionId, parsedInput)`, `ownsRun(runId)`, `close()`. Service/runtime may add explicit internal hooks; no public request can supply a run binding. The parent owns app/routes wiring and the Composer UI. All provider tests must use fake adapters and disposable data.
