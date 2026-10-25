# Team sessions

Teammates' agents are added to a session through the ordinary **Add agents** flow, exactly like local agents. The only difference is that the agent runs on its owner's computer. There is no separate team chat screen. Shared types live at the end of `packages/contracts/src/team-orchestration.ts`.

This replaces the team chat panel as the user-facing surface. The cross-device machinery in `docs/team-orchestration.md` remains in place: consent, proxy sessions, deliveries, artifacts, approvals, activity and leader handover.

## Behaviour

1. **Add agents shows teammates' agents.** In a project bound to a shared team project, the Add agents dialog has a **Teammates' agents** section next to the local provider choices. The section is fed by `GET /api/projects/:projectId/team-agents`. Each agent shows its handle, provider/model, owner, device, and whether it is online. Agents that cannot be added stay visible, disabled, with `unusableReason`.
2. **Adding converts the session.** `POST /api/sessions/:id/team-agents` converts a single session into a multi-agent session (default mode `orchestrated`, the current agent becomes the orchestrator, like the local flow) and adds the remote agent. `POST /api/groups/:id/team-agents` adds one to an existing group. Both return the `GroupSnapshot`. The remote agent is a proxy session member, so modes, @mentions, handoffs, the agents bubble, pause/resume, the result card and Team MCP tools work unchanged.
3. **Who can add.** Only the team lead or an admin, on the host device, because consent grants access to the lead/admins. Adding the first teammate agent to a team project that is not yet enabled enables it implicitly with `leaderOrchestration: true`, `permissionLevel: 'supervised'` and the session's orchestrator as orchestrator. Anyone else sees the section read-only, with the reason.
4. **One team session per project.** The group that holds teammates' agents is the project's team session (`TeamSessionRef`, recorded as the host project's `group_id`). Adding a teammate agent to another group while the current team session still has teammate agents returns 409 with the current session's title. Removing the last teammate agent, or deleting the session, clears the team session. Team mode and owners' consent stay in place, so the next teammate agent added starts a new team session without asking owners to consent again.
5. **Teammates see the same session.** On member devices, every session in a shared project shows the sharing-consent banner whether or not team mode is enabled, so owners can consent during join before the lead creates a team session.
   Once a team session exists, it appears in the project's session list as an ordinary session (title from `TeamStructureSnapshot.teamSession`), rendered with the normal session/group message components, agents bubble and composer. Its transcript is the existing signed team-chat mirror:
   - the host posts the session's human messages and each agent's final reply;
   - a member's composer posts a team-chat message;
   - the host routes it into the group exactly like the lead typing in the session: @mentions go to the mentioned agents, and untagged messages follow the group's mode.
6. **Same rules as local.** Every group mode a local multi-agent session supports also works with teammates' agents. The group-wide permission level and the owner's consent still bound every remote run, as in `docs/team-orchestration.md`.

## HTTP details

- `GET /api/projects/:projectId/team-agents` returns `TeamAvailableAgentsSnapshot`. An unshared project returns null team identifiers and an empty agent list. The host lead/admin can add; other viewers receive `canAdd: false` and a plain-language `reason`. Unavailable teammates remain listed with `usable: false`, `unusableReason`, consent/online state and, when applicable, their existing `groupId`.
- `POST /api/sessions/:id/team-agents` creates a normal `group_*` group with the selected session as its orchestrator, then adds the proxy. `POST /api/groups/:id/team-agents` adds the proxy to an existing group. Both accept `AddTeamAgentSchema` and return `GroupSnapshot`; the optional mode applies only while converting a single session and defaults to `orchestrated`.
- Both add routes require an active lead/admin on the host device (`403`). An unknown agent returns `404`; offline, consent, active-work, duplicate membership and a second team session return `409`. The second-session error includes the current session title. Consent and the group permission level are rechecked at every remote dispatch.
- A team session is exposed in structure snapshots only while the host group has at least one active teammate proxy. Removing the last proxy through `DELETE /api/groups/:id/members/:memberId` removes its roster entry and broadcasts the cleared `teamSession`; the remaining local group stays available.

## Implementation notes

The host stores the ordinary group ID in `mingle_team_host_projects.group_id`; an empty string means team settings exist but no team session has been created yet. Explicitly enabling team mode does not create a group; the first Add agents action creates the ordinary `group_*` session. Existing `teamgrp_*` rows remain readable. Team proxy rows remain unique per `(team, shared project, agent)`, so one proxy session per published agent is reused if the agent is removed and later re-added. Group-member identity/history is still per group.

Owner consent may arrive before the first host team session exists. The host validates and stores that consent against the shared project/device roster; the implicit first add starts at a settings version no lower than the accepted consent version and uses `supervised` permission by default.

## Session policy and names

Any local Claude, Codex, or OpenCode session can be published regardless of its saved policy; publishing never edits that policy. A remote team delivery applies the most restrictive policy among the owner's saved session policy, the project's team permission level, and the owner's consent permission. Policy restrictiveness is ordered `supervised`, `balanced`, `auto`, `full-access`. Thus a supervised team runs even a Full access session as Supervised; a Full access team with Full access consent uses the session's own policy. This is a per-run override only.

During invitation join, the owner selects a policy for each created agent, defaulting to Supervised. New sessions use the owner's display-name first word plus provider (for example, `Aavani's Codex`, then `Aavani's Codex 2`). Join retries use persisted session IDs; the older `Teammate agent <12 hex>` session names remain a migration fallback. Host team handles use the owner's first name as a lowercase ASCII slug, adding a provider suffix and then a number when needed. Existing assigned handles remain stable.

Group-composer user messages are mirrored after local acceptance, using `(source_session_id, source_message_id)` for transcript deduplication. Local group-agent final replies use the run ID as their mirror source; remote agents publish from their owner device with the existing device signature. Member-device team-chat messages are authenticated and queued to the same group routing path, with `@mentions` mapped to group handles and untagged messages using that group's mode. Team-chat delivery and routing run after the HTTP response.

## Performance rules

- Background loops must not emit `state.changed` unless durable, user-visible state actually changed. An idle app with a registered device emits no `state.changed` at all.
- Sending a message must not wait on cloud or network round trips. Transport sync, fan-out and team routing happen after the HTTP response.

## Live updates

Mailbox delivery remains durable and authoritative in the encrypted envelope tables. When Supabase Realtime is available, senders also broadcast an empty wake hint on the recipient's per-device channel; the recipient immediately pulls its authenticated mailbox. The hint contains no message, token or account data and uses public Realtime broadcast, so it requires no table publication or database migration. Realtime failures are silent and the 3-second mailbox polling loop remains the fallback.

Host roster/agent, settings, consent and session-structure mutations, plus member-device structure/consent updates, emit project-scoped workspace events. The web client refreshes the team structure and teammate-agent choices only for those events. Team-chat persistence and run-state changes emit a separate project-scoped event that refreshes the shared transcript and agent bubble; the transcript keeps a slow polling fallback for missed events.
