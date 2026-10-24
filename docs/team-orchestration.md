# Cross-device team orchestration

Goal: agents on different teammates' devices work together exactly like a local multi-agent group — one orchestrator, workers, handoffs, a result card — with the team lead able to restructure the team interactively. Shared types live in `packages/contracts/src/team-orchestration.ts`.

## Product rules

1. **Team project toggle.** Making a shared project a team project (`POST /api/projects/:projectId/team-orchestration/enable`) records `leaderOrchestration` (on/off), a group-wide `permissionLevel` (`supervised` or `full-access`), the orchestrator agent and an optional ordered fallback list. Only the team lead or an admin, on the host device, can change these.
2. **Always orchestrated.** There is no Cowork mode for teams. With `leaderOrchestration` on, an untagged team-chat message goes to the orchestrator agent, which plans and assigns work to workers on any device. With it off, untagged messages reach people only.
3. **Full @mentions across devices.** `@handle` of any consented agent, local or remote, starts that agent (orchestration on or off). Remote runs execute on the owner's device.
4. **Consent instead of per-request approval.** When joining (or later from settings), a teammate chooses which of their agents to contribute and accepts `TEAM_CONSENT_DISCLAIMER`: the lead/admins get sandboxed access to those agents. Consent records the accepted permission level, settings version and disclaimer version. If the lead raises the level (supervised → full-access) or the disclaimer version changes, consent becomes `needs-reconsent` and the owner device rejects new deliveries until the owner re-accepts. Owners can pause or revoke at any time from their own device; this is always honoured locally.
5. **Sandboxed.** Remote-requested runs use an isolated worktree on the owner's device, run with the group permission level (never above the consented level), never push, and never read outside that worktree beyond what the provider runtime already allows. Provider credentials never leave the owner device.
6. **Supervised approvals.** In supervised mode a remote run's approval requests are shown on the owner device (existing UI) and mirrored to the host, where the lead/admin may decide. First decision wins; the owner can always deny.
7. **Everything through Git.** Workers commit in their worktree. Committed artifacts are transferred with the existing distributed Git API into isolated refs on the integration device (the orchestrator's device). Nothing is merged into the user's branch or pushed automatically.
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

Host offline ⇒ no new team work is scheduled (members see the host as offline). Max 64 agents per team project, 4 fallbacks, 8 contributed agents per device. Activity mirrors keep the latest 500 entries per agent.
