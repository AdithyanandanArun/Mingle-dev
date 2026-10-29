# Provider feature coverage

Updated 2026-10-29 using native harness protocols and original Mingle UI. This records the current scope of the provider integration.

| Feature | Codex | Claude | Antigravity | OpenCode |
| --- | --- | --- | --- | --- |
| Model discovery | App-server `model/list` | SDK `supportedModels()`; canonical aliases retained | Authenticated ACP configuration | ACP model selector and per-model variants |
| Reasoning | Advertised levels, including Extra High/Max/Ultra when supported | Advertised SDK levels; unavailable controls omitted | Per-model native thinking levels; unknown values stay Native default | Per-model native variants; unknown values stay Native default |
| Speed | Standard or advertised service tier; explicit standard-speed override | Standard; Fast only when the model reports support | Standard only | Standard only |
| Permissions | Supervised, Auto-accept edits, native Auto reviewer, Full access | Native default, acceptEdits, model-supported auto, bypassPermissions | Supervised, Auto-accept edits, Full access through native modes | Supervised, Auto-accept edits, Full access through per-run permission rules; Auto unsupported |
| Saved defaults | Model, effort, permission policy and service tier | Same, validated against selected model | Model, effort and permission policy; Standard tier | Model, effort and permission policy; Standard tier |
| `/` picker | Mingle workspace commands; no provider slash-command API | Mingle commands plus SDK-reported commands and aliases | Asynchronously reported ACP commands | ACP commands, including native skills, for the session folder |
| `$` picker | Native installed skill catalog; explicit skill input items | SDK skill catalog; one selected skill dispatched by name | Unsupported | Unsupported; native skills are available through `/` |
| Skill scope | Scopes returned by Codex `skills/list` | Bundled/project/available plugin skills reported under the project settings source | Provider-owned skills are not selectable through Mingle | Native ACP command catalog in the opened project folder |
| Catalog refresh | On session/model changes, reconnect or explicit retry; fresh selection validation before a run | Same; metadata RPCs have a bounded deadline and close the CLI afterward | Native command/model refresh without inference | Metadata-only ACP session; project command discovery uses the opened session folder |
| Shared browser and team tools | Run-scoped local MCP servers over HTTP | Same, injected through SDK HTTP MCP | ACP HTTP MCP when advertised; otherwise local stdio-to-HTTP bridge | ACP HTTP MCP when advertised; otherwise local stdio-to-HTTP bridge |
| Progress tools | Run-scoped Mingle status and checklist MCP tools over HTTP | Same over SDK HTTP MCP | ACP HTTP MCP when advertised; otherwise local stdio-to-HTTP bridge | ACP HTTP MCP when advertised; otherwise local stdio-to-HTTP bridge |
| Subagent rail | `spawnAgent`/`spawn_agent` calls; captures reported child-thread assistant text and tool activity under the spawn call. Requested model is retained when supplied. | `Task`/`Agent`; captures child assistant text and tool activity through `parent_tool_use_id`, with model from tool input when supplied | No dedicated native subagent spawn identity or child-session relationship in the inspected ACP 1.4.1 interface; generic tools are not grouped as subagents | Native `task` launch with reported type/description, prompt, status and result. Child updates attach when ACP supplies a parent tool-call or mapped child-session ID; otherwise the rail shows launch/result only |
| Auto-compaction | Native per-thread token threshold from provider capacity metadata | Native percentage environment override | Native behavior only; custom threshold unsupported | Native behavior only; custom threshold unsupported |
| `/usage` | Native quota windows, credit balance, available reset count and grant expiry details when reported | Native five-hour, seven-day and applicable scoped windows; no spendable credit balance or reset-grant count exposed by the SDK | Native maintenance command on the verified runtime version | Unavailable; ACP exposes no account quota or credits |

## Antigravity

Google's ACP runtime is a third independent provider. Settings includes explicit installation, Google sign-in, cancellation and reconnection. Model choices come from authenticated native configuration metadata; unknown thinking controls remain **Native default**. Supervised, Auto-accept edits and Full access map to ACP modes, with approvals returned to the provider through its permission request protocol. Standard is the only Mingle service tier exposed.

Independent sessions and group agents share the existing runtime, worktree, tool activity and change-summary machinery. Browser, team and progress MCP servers are supplied per session with ephemeral authorization. ACP HTTP MCP is preferred; if it is not advertised, a private local stdio bridge forwards to the existing run-scoped HTTP endpoint. Native conversation IDs are retained for later turns. Native command metadata is cached without sending discovery prompts.

Native history import, explicit skill attachments and a custom compaction threshold are unsupported. Quota reads use only the verified runtime's native maintenance command; unknown credit/reset fields remain unreported. An installed runtime is not proof of a valid Google login or account entitlement. See [Antigravity protocol research and limits](provider-antigravity.md).

## OpenCode

OpenCode's native ACP server (`opencode acp`) is the fourth independent provider. Models are its `provider/model` IDs, reasoning effort is its native model variants with an explicit Native default, and the `/` picker lists the commands (including skills) it advertises for the session folder, discovered without a prompt. Supervised, Auto-accept edits and Full access are enforced with per-run OpenCode permission rules; Auto is unsupported. Browser, team and progress MCP use HTTP when advertised and the local stdio bridge otherwise. OpenCode's `task` tool appears in the subagent rail; child transcript/tool details are linked only when ACP exposes the parent or child-session identity. Native history import, usage/quota, the `$` skill picker, a custom compaction threshold and service tiers are unsupported and reported explicitly. See provider-opencode.md for protocol details and verification limits.

## Mingle commands

`/new`, `/stop`, `/settings`, `/model`, `/effort`, `/permissions`, `/tier`, `/skills`, `/usage`, `/status`, `/diff` and `/help` are local Mingle actions. They do not start inference. Mingle commands take precedence over provider commands with the same names. Other Claude commands dispatch through the SDK's documented slash syntax. Codex terminal UI slash commands require individual client integrations; they are not sent as pretend prompt aliases.

The usage dialog separates Mingle conversation token/cost totals from account-wide quota windows shared with other apps. It shows percentages remaining and native reset timestamps in the local timezone, with a live countdown. Unknown values and replenishment schedules stay explicitly unreported. Manual refresh is rate limited and concurrent reads are coalesced; no reset redemption is exposed. See [Codex usage mapping](codex-usage-research.md) and [Claude usage mapping](claude-usage-research.md).

The picker supports caret-aware completion, arrow navigation, Enter/Tab selection and Escape dismissal. In a group composer, address provider actions to one member with `@handle /command arguments` or `@handle $skill arguments`; selection is checked against that member's fresh catalog again at dispatch. Actions stay on the addressed agent and use its saved settings. Codex accepts explicit native skills but does not expose prompt-style slash commands; Antigravity does not offer a Mingle-selected skill catalog. Deleting a skill marker removes its binding. Unsupported model settings fail clearly. Saved inherited settings can adapt when selecting a different model.

Session and group composers also support `@/path`: typing the prefix at the caret opens the workspace file picker with the path query prefilled. Selecting a file removes only the matching trigger and adds a structured file context reference to the draft; Escape leaves the typed text intact. In a group, an explicit single `@handle` or recipient selection scopes the picker and reference to that member's worktree. Broadcasts and default routing use the anchor session's worktree. The existing `@files` picker entry remains available. This is Mingle's context workflow, not a provider-native mention or command feature; the selected reference is passed through the message context contract.

## Remaining coverage

Personal Claude settings/skills are not imported. Its SDK couples the user settings source to permission rules and other configuration; Mingle currently keeps its project source and disabled hooks. Discovery notices explain this boundary. Fast mode and automatic review remain subject to provider/account policy and availability.

Native plan generation and review (including revision, dependency editing, approval and explicit execution) and interactive provider questions are implemented for Codex, Claude, OpenCode and Antigravity when each native runtime supports the requested operation; Mingle does not simulate provider plan mode. Advanced context inspection, general MCP/plugin management, and additional native command actions still need their own client implementations. Attachments and targeted provider actions are covered in [chat attachments and native actions](chat-attachments-and-native-actions.md), including their provider limits. The existing file editor, terminal, Changes, tasks and activity views remain available.

The shared browser and automatic compaction setting are covered in [browser setup and limits](shared-browser.md). General MCP server/plugin management remains separate from Mingle’s built-in browser connection.

## References

- [Codex App Server](https://learn.chatgpt.com/docs/app-server) and the installed Codex CLI 0.160.1 JSON schema.
- [Claude Agent SDK skills and commands](https://code.claude.com/docs/en/agent-sdk/slash-commands) and installed SDK 0.3.302 declarations.
- [Codex control mappings](codex-controls-research.md), [Claude control mappings](claude-controls-research.md), and [validation record](validation.md).
