# Team sessions

Teammates' agents are added to a session through the ordinary **Add agents** flow, exactly like local agents. The only difference is that the agent runs on its owner's computer. There is no separate team chat screen. Shared types live at the end of `packages/contracts/src/team-orchestration.ts`.

This replaces the team chat panel as the user-facing surface. The cross-device machinery in `docs/team-orchestration.md` remains in place: consent, proxy sessions, deliveries, artifacts, approvals, activity and leader handover.

## Behaviour

1. **Add agents shows teammates' agents.** In a project bound to a shared team project, the Add agents dialog has a **Teammates' agents** section next to the local provider choices. The section is fed by `GET /api/projects/:projectId/team-agents`. Each agent shows its handle, provider/model, owner, device, and whether it is online. Agents that cannot be added stay visible, disabled, with `unusableReason`.
2. **Adding converts the session.** `POST /api/sessions/:id/team-agents` converts a single session into a multi-agent session (default mode `orchestrated`, the current agent becomes the orchestrator, like the local flow) and adds the remote agent. `POST /api/groups/:id/team-agents` adds one to an existing group. Both return the `GroupSnapshot`. The remote agent is a proxy session member, so modes, @mentions, handoffs, the agents bubble, pause/resume, the result card and Team MCP tools work unchanged.
3. **Who can add.** Only the team lead or an admin, on the host device, because consent grants access to the lead/admins. Adding the first teammate agent to a team project that is not yet enabled enables it implicitly with `leaderOrchestration: true`, `permissionLevel: 'supervised'` and the session's orchestrator as orchestrator. Anyone else sees the section read-only, with the reason.
4. **One team session per project.** The group that holds teammates' agents is the project's team session (`TeamSessionRef`, recorded as the host project's `group_id`). Adding a teammate agent to another group while the current team session still has teammate agents returns 409 with the current session's title. Removing the last teammate agent clears the team session.
5. **Teammates see the same session.** On member devices, the team session appears in the project's session list as an ordinary session (title from `TeamStructureSnapshot.teamSession`), rendered with the normal session/group message components, agents bubble and composer. Its transcript is the existing signed team-chat mirror:
   - the host posts the session's human messages and each agent's final reply;
   - a member's composer posts a team-chat message;
   - the host routes it into the group exactly like the lead typing in the session: @mentions go to the mentioned agents, and untagged messages follow the group's mode.
6. **Same rules as local.** Every group mode a local multi-agent session supports also works with teammates' agents. The group-wide permission level and the owner's consent still bound every remote run, as in `docs/team-orchestration.md`.

## Performance rules

- Background loops must not emit `state.changed` unless durable, user-visible state actually changed. An idle app with a registered device emits no `state.changed` at all.
- Sending a message must not wait on cloud or network round trips. Transport sync, fan-out and team routing happen after the HTTP response.
