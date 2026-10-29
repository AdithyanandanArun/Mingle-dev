# Group conversations

Use **Add agent** in an existing session to work with several independent coding agents in one conversation. Adding a participant saves its settings and creates its workspace; it does not start inference. Existing native conversation IDs and history stay with their original session.

## Choose how work is coordinated

| Choice | Existing agent | New agent | Message without a recipient |
| --- | --- | --- | --- |
| Cowork | Equal peer, initially the request planner | Equal peer | Both peers receive the request; one planner splits it before the other edits |
| Orchestrated | Worker, with an explicit Keep/Change configuration choice | Worker | Separate coordinator from Settings |
| Current agent leads | Orchestrator with its existing history and configuration | Worker | Existing orchestrator |

The animated choice diagrams illustrate routing. They are not live progress. Pause motion and the operating system's reduced-motion preference keep the choices usable without animation.

The add-agent flow previews the provider, unique handle, model, effort, service tier, permissions and workspace. New participants use isolated Git worktrees by default. Existing sessions retain their current directory; imported conversations are not moved. A repository needs an initial commit for worktree creation. Working in a shared folder requires explicitly opting out of isolation.

## Addressing and the timeline

Choose an agent recipient or type its handle, such as `@claude1` or `@codex1`. The composer previews the resolved recipients. A direct message starts work only for its recipients. Unaddressed routing follows the selected mode. Unknown handles reject rather than being sent to a different agent. Handles in quoted text, URLs or code are not dispatch instructions.

Responses, tool activity, approvals, elapsed time and changed files retain the member and native run that produced them. Each member can have only one provider turn at a time. A separate provider process or native conversation is not a second shared context window: Mingle sends compact assignments and references, not everyone's full transcript.

Agent names use a consistent individual color, with an OpenAI or Claude mark taken from the associated session's provider. The handle identifies the participant; the provider mark identifies its runtime. Two Codex participants still have separate worktrees, conversations and runs.

When delegated work finishes, Mingle queues a results handoff to the assigning agent. If that agent is still working, its follow-up waits for the current turn to finish. The handoff's delivery state describes that follow-up turn; it does not certify that files were integrated or that a task passed review. Read the agent's final response and changed-file summary for the actual outcome. Detailed internal handoff instructions remain available in a disclosure.

Native guidance asks the coordinator or Cowork planner to finish with one human-readable summary that opens with an outcome (Implemented, Partially complete or Blocked) and material caveats. It names each agent's contribution, where work was actually integrated, which checks the coordinator ran versus which a peer reported, and what still needs review or action, and says Pending while workers run. In full access (local `autonomy.mode: extended`, or cross-device team `permissionLevel: full-access`), the coordinator verifies results and may call `team_accept`; Mingle marks accepted tasks done and merges local worker branches into the group integration worktree. Local workers commit scoped changes before Review so their branches can be integrated. Supervised and balanced groups keep human acceptance. Workers publish required committed handoff files once (none invented when nothing is committed), record Review when ready, then send a final summary without repeated completion messages. Unresolved blockers remain visible. This is model guidance, not a certification: Mingle does not infer success from a finished turn.

Completed files can live in the integrating agent's isolated worktree rather than the original project folder. The checkout control and file links identify that location. Finishing a provider turn does not automatically commit or publish files; in a full-access local group, accepted committed worker branches are merged into the group integration worktree.

The **Team result** card stays at the bottom of the conversation for the latest human request. While work runs it shows a compact progress header; full-access requests say **Working autonomously** while Mingle coordinates, reviews and integrates. Once work settles, the same card shows the lead's single final report, each participating agent's assigned tasks and report, saved file changes, and checkout locations. Review, accepted tasks, incomplete work, failure, interruption and pauses have distinct labels. During an active autonomous request, Review tasks say they await coordinator verification instead of human review. Reports and paths expand on demand. The lead's result follow-up and workers' assignment reports take precedence over later acknowledgments. Missing records remain unavailable, and the card starts no extra model turns or task-state changes.

Long result cards open at their outcome heading when following the latest activity; scrolling back through history still disables automatic following. The Latest button uses the same outcome-first position. Report previews shorten Markdown links and skip task identifier metadata, while the full agent report remains available.

Installed-desktop inspection on 2026-10-20 confirmed the existing two-agent request showed Review and the saved coordinator result, rather than the worker's later acknowledgment. A subsequent user-started request displayed compact live progress, then a blocked task and three participants alongside the lead's partial-completion report. With a roughly 669 px card in a 433 px conversation viewport, the outcome heading remained visible. Native preview screenshot capture failed; focused DOM inspection was used. Workspace type checks and the production Arch package build passed; no automated tests or paid validation runs were started. The final display update was installed with the identical running backend retained; an existing desktop window can refresh to load the final display changes.

A separate provider-backed integration proof ran on 2026-10-20 using an isolated OpenCode lead, Codex backend worker and OpenCode frontend worker. Mingle delivered the committed contract to the dependent frontend automatically while the backend task remained in Review; the lead integrated both commits and the tasks remain pending human acceptance. See [the full live proof and check evidence](group-session-live-proof.md). Claude interoperability and fixed cost savings were not tested.

The floating agent bubble stays at the right as messages scroll, without reserving a sidebar column. It shows each active member's provider identity, configuration and current state. An agent doing work with a pending follow-up remains **Working**, with the queued count shown alongside it. Approval waits, pauses, errors and idle states are shown separately. Working time uses the native run's start time; queue age is not reported as work time. During a connection loss, the list identifies its state as last known.

Opening the right context pane fades the bubble away; closing the pane restores it smoothly. The bubble can collapse to a small activity summary and defaults to that compact form in narrow or short windows. Expanding it shows individual statuses, with its height bounded above the composer. Sidebar and background transitions work in both directions and respect reduced motion. The Members menu remains available for agent settings and controls.

## Agent communication

During a recorded group run, Codex and Claude receive the same host-authenticated team interface:

- `team_members`: actual membership, roles and run state, plus provider/model/effort, local-vs-remote owner, queued/running load, health and active assignment scopes.
- `team_inbox`: messages and artifact references addressed to that member.
- `team_assign`: scoped objective, task ownership, acceptance criteria and prerequisites.
- `team_message`: targeted note, question or reply.
- `team_artifact`: verified committed file and revision delivered through Mingle's artifact handoff boundary.
- `team_status`: progress, blocker or Review for the sender's own task.

Only the designated orchestrator or Cowork's temporary request planner can schedule assignments. Peer messaging does not grant delegation authority. Tool results confirm queueing or recording, not successful completion. Plain model output containing an `@handle` is never executed as a dispatch command.

`team_assign` accepts a member handle or `recipient: "auto"`. Automatic selection preserves scope continuity first, then prefers lower running+queued load, healthier state and a provider not already running. The result names the selected member and the reason. Split planned work into non-overlapping file/directory scopes: Mingle rejects a new scope that overlaps another member's queued, running or Review assignment, even across isolated worktrees. The current scope owner may queue overlapping follow-up work; a completed/accepted task releases its scope, while a fallback reassigns scope ownership to the replacement.

Task dependencies normally require Done. An assignment can explicitly name an expected artifact dependency; the corresponding verified committed artifact can unblock that consumer while its producer remains in Review. In full access, only the active coordinator can accept after supplying verification evidence; local acceptance merges the worker branch before marking the task Done and pushes the group integration branch normally. Supervised and balanced groups keep human acceptance. Referencing a commit does not merge it into another worktree.

## Limits, interruption and recovery

**Settings → Agents & orchestration** stores coordinator/worker defaults and default limits. Existing groups keep their own configuration. Group controls expose actual members, settings, queued deliveries, interruption and pause/resume.

Parallel runs, automatic turns and message hops are bounded. Full-access requests automatically extend their per-request budgets without changing group settings or resetting usage: turns can reach four times the configured effective limit, capped at 200, and hops can reach an internal ceiling of 24. Each extension records `group.budget.auto-extended`; reaching a hard ceiling pauses with a visible reason. Supervised and balanced groups keep their configured holds. Status events do not create model turns. A question that requests an answer can wake its recipient within the active request's limits. Failures and limit exhaustion stay visible.

Full access also enables bounded self-healing. After the existing one-time continuation retry, a failed assignment can move automatically to an available replacement while retaining its task, scope and acceptance criteria; at most two fallback moves are made per task. Configured replacements are preferred, then the scheduler chooses an available low-load member, preferring a different provider and avoiding the coordinator unless necessary. Replacement instructions include a bounded report and the failed worker's committed local commit or permanent cross-device branch. Quota/rate-limit cooldowns use the provider reset time or 15 minutes by default. No replacement outside current permission/consent, device availability and work-scope checks is dispatched. If every candidate is unavailable, the group pauses with a clear transcript blocker.

An active delivery with no provider/tool/team activity for 10 minutes is shown as stalled. Full access interrupts it and retries once on the same member before considering fallback. Pending human approvals and provider questions are waiting states, not stalls. Supervised/balanced runs are surfaced for the existing human interrupt and recovery controls without automatic interruption or reassignment.

Pause holds new scheduling while native runs already in progress can finish. Stop pauses automatic scheduling and interrupts the group’s runs. Stopping one member cancels its queued work and holds it; its Resume action can retry eligible interrupted work. It does not silently restart. SQLite preserves membership, messages, assignments and deliveries. On restart, supervised/balanced groups remain paused for explicit recovery. Full-access groups queue at most one continuation per interrupted delivery after provider discovery; the continuation instructs the agent to inspect its persistent workspace and recovery checkpoint before repeating possible side effects. A cross-device host interrupts the old owner-device turn before releasing its proxy slot for a fresh delivery to the same agent. Reopening Mingle does not resume standalone sessions automatically when automatic continuation is disabled.

Credentials for the team tools are temporary, scoped to one run and kept out of durable source/history. The server validates the invoking member, active delivery, permissions and coordination authority on every operation. A local extended group uses provider-native Full-access only when that provider/model advertises it, without rewriting the member's saved session policy. Cross-device approvals remain bounded by current host permission and owner consent; replacement agents also require a current Full-access owner consent and an online device. Browser access remains a separate capability with its existing tab ownership and human controls.

Cowork avoids an extra coordinator conversation. Every participating model still consumes its own quota and tokens; no fixed cost reduction is guaranteed.
