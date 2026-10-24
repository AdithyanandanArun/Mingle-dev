# Cross-device team orchestration

Goal: agents on different teammates' devices work together exactly like a local multi-agent group — one orchestrator, workers, handoffs, a result card — with the team lead able to restructure the team interactively. Shared types live in `packages/contracts/src/team-orchestration.ts`.

## Product rules

1. **Team project toggle.** Making a shared project a team project (`POST /api/projects/:projectId/team-orchestration/enable`) records `leaderOrchestration` (on/off), a group-wide `permissionLevel` (`supervised` or `full-access`), the orchestrator agent and an optional ordered fallback list. Only the team lead or an admin, on the host device, can change these.
2. **Always orchestrated.** There is no Cowork mode for teams. With `leaderOrchestration` on, an untagged team-chat message goes to the orchestrator agent, which plans and assigns work to workers on any device. With it off, untagged messages reach people only.
3. **Full @mentions across devices.** `@handle` of any consented agent, local or remote, starts that agent (orchestration on or off). Remote runs execute on the owner's device.
4. **Consent instead of per-request approval.** When joining (or later from settings), a teammate chooses which of their agents to contribute and accepts `TEAM_CONSENT_DISCLAIMER`: the lead/admins get sandboxed access to those agents. Consent records the accepted permission level, settings version and disclaimer version. If the lead raises the level (supervised → full-access) or the disclaimer version changes, consent becomes `needs-reconsent` and the owner device rejects new deliveries until the owner re-accepts. Owners can pause or revoke at any time from their own device; this is always honoured locally.
5. **Sandboxed.** Remote-requested runs use an isolated worktree on the owner's device, run with the group permission level (never above the consented level), never push, and never read outside that worktree beyond what the provider runtime already allows. Provider credentials never leave the owner device.
6. **Supervised approvals.** In supervised mode a remote run's approval requests are shown on the owner device (existing UI) and mirrored to the host, where the lead/admin may decide. First decision wins; the owner can always deny.
7. **Everything through Git.** Workers commit in their worktree. Committed artifacts travel through the encrypted distributed Git transport into isolated refs on the integration device (the orchestrator's device). Inputs to remote runs are transferred into the owner's local repository before the run starts. Nothing is merged into the user's branch or pushed automatically.
8. **Leader handover.** If the orchestrator fails with `quota_exhausted` or its device goes offline, the host promotes the first available fallback (recorded in `leaderHistory` with reason `fallback-quota`/`fallback-offline`). With no usable fallback the group pauses and `needsLeader` is true until a human picks a leader in the Team structure view. When the original leader returns it stays where the lead put it (worker or idle) until the lead promotes it again (`restored`).
9. **Interactive structure.** A new **Team structure** item in the project sidebar menu (next to Tasks, Activity, Agent map) shows an interactive tree: orchestrator at the top, workers below, an idle bench, fallback ranks, device/owner badges and live states. Lead/admin on the host can drag an agent onto the leader slot to promote/swap, drag to the bench to idle, reorder fallbacks, and remove agents. Others see it read-only.
10. **Agent's own conversation.** Clicking an agent in the floating presence bubble opens a drawer with that agent's own conversation (`GET .../team-agents/:agentId/activity`): requests it received, its replies, tool summaries, approvals, artifacts, errors. Remote agents are mirrored from `teamgroup.activity` updates sent by the owner device.

## Architecture

- **Host device** = the device bound to the team lead account that owns the shared project binding. The host runs a normal local `ConversationGroup` in mode `orchestrated` for the team project. Remote agents are represented on the host by **proxy sessions**: local `Session` rows marked as team proxies (table `mingle_team_proxy_sessions`), so the existing group scheduler, handoffs, result card and Team MCP tools work unchanged.
- **Runtime seam.** When the group scheduler calls `runtime.start(sessionId, …)` for a proxy session, the host sends `teamgroup.delivery` to the owner device instead of starting a provider. `teamgroup.delivery.status` updates feed the proxy session's messages/run state and finally `groups.onRunFinished(sessionId, runId, outcome)`. Interrupts send `teamgroup.interrupt`.
- **Owner device executor.** Validates the delivery (sender is the host device of that team, sender account is lead/admin, consent `granted` for that agent, permission level ≤ consented, settings version not older than consent), maps `agentId` → local session, starts the run in an isolated worktree with the group permission level, streams `teamgroup.activity`, forwards approvals, proxies Team MCP tool calls to the host as `teamgroup.tool.call`, exports committed artifacts to the integration device, and posts its final status.
- **Team chat.** Human messages keep their existing signed fan-out. On the host, an untagged message (orchestration on) becomes a group request for the orchestrator; mentions become direct deliveries. Agent replies are posted to team chat signed by the device that ran the agent.
- **Structure broadcast.** The host broadcasts `teamgroup.structure` after each change so every member device can serve `GET /team-structure` read-only.
- Transport latency: after sending any `teamgroup.*` envelope, request an immediate transport sync instead of waiting for the periodic loop.

## Artifact transfer

`GitSyncService.exportTeamArtifact` packages a committed revision from the owner-selected shared repository and queues a `git.team-artifact.offer` plus encrypted `git.team-artifact.chunk` messages to the delivery's `integrationDeviceId`. Receivers enforce the existing 16 MiB bundle ceiling, 128 KiB chunks (at most 128), canonical base64, aggregate SHA-256, `git bundle verify`, and an exact advertised revision. Because the sender cannot establish the receiver's object ancestry before dispatch, artifact bundles currently include all history reachable from the selected commit; the optional base revision is validated as metadata but is not used to make a potentially incomplete bundle. A bundle too large to transfer fails rather than splitting into an unbounded set of transfers.

The receiver imports only the claimed commit into a deterministic ref under `refs/mingle/team/`, with project/delivery identifiers sanitized and collision-resistant. It verifies the ref tip after fetch and never checks out files, updates HEAD, or changes a user branch. Duplicate imports of the same transfer are idempotent. Team output transfers require a still-active peer link, a matching durable delivery, the producing owner's device, active roster membership and current consent. On an owner device, input transfer offers may arrive immediately before `teamgroup.delivery`; the receiver first validates the active host and local consent, then rechecks the exact delivery and integration device before import.

The host imports returned refs before completing its proxy delivery and stores only successfully imported artifact references. It adds those ref names to the result delivered to the orchestrator. For remote runs, committed handoff inputs are exported to the owner device, listed in `inputArtifacts`, and named in the run prompt before provider execution. The orchestrator can inspect the content with Git and explicitly merge or cherry-pick from a ref. Artifact transfer does not itself integrate commits, validate their behavior, or push them. Team consent authorizes this transfer path; it does not change the separate approvals required by ordinary user-requested Git handoffs.

## REST surface

| Method & path | Device | Who |
| --- | --- | --- |
| `POST /api/projects/:projectId/team-orchestration/enable` | host | lead/admin |
| `PATCH /api/projects/:projectId/team-orchestration` | host | lead/admin |
| `GET /api/projects/:projectId/team-structure` | any member | any member |
| `POST /api/projects/:projectId/team-structure/changes` | host | lead/admin |
| `POST /api/projects/:projectId/team-consent` | owner | owner |
| `PATCH /api/projects/:projectId/team-consent` | owner | owner |
| `GET /api/projects/:projectId/team-agents/:agentId/activity` | any member | any member |

Errors use the standard `{error}` body; version conflicts return 409.

## Limits

Host offline ⇒ no new team work is scheduled (members see the host as offline). Max 64 agents per team project, 4 fallbacks, 8 contributed agents per device. Activity mirrors keep the latest 500 entries per agent. Team delivery payloads carry at most 30 artifact references; each artifact bundle is at most 16 MiB.

## Implementation notes

The host-side service is `apps/server/src/team-orchestration/host/service.ts`; `apps/server/src/team-orchestration/index.ts` constructs it and composes an optional owner-device side. Migration 20 creates `mingle_team_host_projects`, `mingle_team_host_roster`, `mingle_team_host_consents`, `mingle_team_host_deliveries`, `mingle_team_host_approvals`, and `mingle_team_proxy_sessions`. The settings/history and delivery/approval rows stay local to the host. Proxy sessions are ordinary local `sessions` rows with a separate owner/device mapping; they use the bound project path only as their local metadata workspace, and the host never launches a provider for them.

The host REST routes implement `POST .../team-orchestration/enable`, `PATCH .../team-orchestration`, `GET .../team-structure`, and `POST .../team-structure/changes`. Enable and edits resolve the verified collaboration roster, require an active lead/admin, and require the current device to match the source binding's leader device. Settings and structure writes use `expectedVersion`, return 409 when stale, increment the version on success, and broadcast a schema-validated `teamgroup.structure` to mutually linked active devices followed by immediate transport sync. Structure edits update the scheduler roster without starting inference; an explicit leader handover may resume retained planner work.

The proxy runtime seam records the host run/user message and sends a validated `teamgroup.delivery` containing the group-generated prompt plus group instructions, role, group/request/delivery IDs, permission level, settings version and host integration device ID. Authenticated `teamgroup.delivery.status` updates map to host session/run state; completion appends scrubbed assistant text and calls `groups.onRunFinished`. Host-side approvals appear in the existing approvals list and decisions return as `teamgroup.approval.decision`. Tool calls are validated and executed through the run-bound Team MCP bridge. A missing status fails the proxy after 90 seconds by default (bounded to 15 minutes); tests can inject the clock and timeout.

Quota-exhausted/offline leader handover walks the configured fallback order, requiring a current grant, online owner device and no recorded quota exhaustion. A successful change is added to leader history and retained work is redirected through the existing scheduler. If no fallback qualifies, the group pauses, `needsLeader` is broadcast and a signed team-chat status is posted. A returning leader is not automatically restored.

`TeamChatService` delegates enabled-host human messages to the group queue: mentions target their exact published agent IDs, and untagged requests target the orchestrator only when leader orchestration is on. Disabled projects keep the original local mention path. Host-run local agent replies and orchestration status messages use the existing provenance signing/fan-out implementation; remote agent replies remain the owner device's responsibility.

The owner-side factory is injected through `TeamOrchestrationDeviceSideFactory` in `team-orchestration/types.ts`; its expected shape is `createDeviceSide({store, runtime, hub, transport, account, distributed, collaboration, teamChat, changed}) -> {routes(add), close(), latestStructure(sharedProjectId), localConsent(sharedProjectId)}`. The app accepts this factory optionally so the host runs without it. When absent, host routes and local orchestration remain available, but owner-side delivery execution/consent routes and non-host structure caching are not provided. The owner executor imports delivery inputs before starting, exports committed completion revisions to the integration device, and reports transfer failures. The host verifies/imports completed artifact refs and includes them in the orchestrator-facing result.

`TeamStructurePayloadSchema` gained optional `host` identity and per-member `consent` fields so a validated broadcast can populate the read-only structure view on another device. Existing required payload fields and message names remain unchanged.
