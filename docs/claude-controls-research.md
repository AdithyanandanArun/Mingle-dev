# Claude provider controls research

> **Naming note:** Mingle was named Relay when these observations were recorded. Historical commands, paths, tool names and artifact receipts are retained. See [current naming and data compatibility](mingle-rename.md).

Research checked 2026-10-19 against Anthropic's Agent SDK documentation and the installed `@anthropic-ai/claude-agent-sdk@0.3.302` declaration files.

## Permission policies

The SDK's `Options.permissionMode` accepts `default`, `acceptEdits`, `auto`, and `bypassPermissions` among its native modes. Relay maps its policies directly:

| Relay policy | Claude Code mode | Behavior |
| --- | --- | --- |
| `supervised` | `default` | Unresolved tool requests go through Relay's `canUseTool` approval callback. |
| `balanced` | `acceptEdits` | Claude Code's native edit permissions are accepted; other unresolved requests use Relay approval. |
| `auto` | `auto` | Claude Code's permission classifier decides when possible and can request Relay approval. The SDK model catalog reports `supportsAutoMode` per model, so Relay advertises this mode only for those models. |
| `full-access` | `bypassPermissions` | Claude Code bypasses normal permission prompts. The SDK requires `allowDangerouslySkipPermissions: true`; Relay sets it only for this explicit policy. |

The SDK notes that managed or project settings can disable escalating permission modes. If Claude Code rejects a selected mode, the run surfaces the provider failure rather than changing to another policy.

## Model effort and service tier

`Options.effort` is typed by the installed SDK as `low`, `medium`, `high`, `xhigh`, and `max`, while the runtime receives string model metadata. `supportedModels()` supplies `supportsEffort` and `supportedEffortLevels` per model. Mingle preserves bounded, syntactically safe effort IDs exactly as advertised, including values newer than the installed type union. Missing effort metadata produces no choices and uses the provider's native default; an explicitly empty list remains explicitly empty; `supportsEffort: false` also produces no choices. In all three cases Mingle omits the SDK `effort` option rather than guessing a value.

`ModelInfo.value` is the exact model ID. Mingle uses only the SDK's reported catalog for listed models. When that catalog is unavailable, the saved model remains visible but is marked as not in the current catalog. A separate bounded custom model ID entry is available in the model picker; it sends the exact ID and does not imply account access. Claude validates account/model access when the actual run starts.

There is no SDK `serviceTier` option. However, the SDK's `Settings` type includes `fastMode`, and `Options.settings` accepts an inline settings object loaded at the highest flag-settings layer. `supportedModels()` also reports `supportsFastMode`. Relay therefore offers `standard` for each model and `fast` only for models that report support, passing `fastMode: true` for fast and explicit `false` for standard. Fast mode can still be unavailable for the current account, usage state, environment, or backend; the SDK exposes `fast_mode_state` and `fast_mode_disabled_reason` during initialization. Relay stops when that initialization does not report fast mode as on and never falls back to standard. The SDK's string-prompt query may already have begun processing before initialization status reaches the host, so this check does not guarantee that no provider request was sent.

## Commands and skills

The TypeScript SDK `Query` API exposes `supportedCommands()`, `reloadSkills()`, and `supportedModels()` after initialization. Slash-command entries provide names without `/`, descriptions, argument hints, aliases, and a `builtin` marker; `reloadSkills()` returns the actual refreshed skill list. Relay keeps an async prompt stream open without yielding any user message, reads those metadata APIs, and closes the query without sending a user turn. Catalog and model probes race initialization and reads against a hard 15 second deadline; timed-out queries are closed.

The SDK does not report a filesystem path, source, or a separate prompt/action field for each command. Relay preserves the reported command name, description, hint, and aliases. SDK slash commands use prompt syntax for dispatch, so Relay marks them as prompt commands regardless of the `builtin` marker; that marker describes collision precedence, not command type. For skills, Relay uses the separate `Query.reloadSkills()` response instead of guessing from slash-command entries. If skill reload is unsupported or fails, Relay retains the independently read command list and reports a skill-discovery warning. Both APIs omit filesystem source, so Relay uses the generic provider source because entries can originate from project files, plugins, or MCP servers. The SDK documents collision precedence: an actual command name beats an alias with the same name, and a built-in command beats a custom command with the same actual name. Relay applies that precedence before exposing selectable skills, so a shadowed custom skill is not offered.

When a session selects one project skill, Relay passes its exact name through the SDK `skills` allowlist and dispatches it using the SDK-documented `/<name>` prompt syntax, followed by the user's request. Multiple selected skills are rejected with a clear error because the SDK does not document a multi-skill composition protocol for one prompt.

Personal user skills are not loaded. The SDK documents `settingSources: ['user', 'project']` as the way to enable personal skills, but it loads user settings alongside those skills. There is no skills-only user setting source in the SDK declarations, so enabling it would also import user permission rules and hooks. Relay keeps the existing project-only source boundary and reports this limitation in the catalog warning. This means SDK-reported commands and skills remain source-unknown and use the generic provider source in Relay.

Metadata discovery supplies an async prompt iterator that remains open until cleanup but never yields a `SDKUserMessage`. This keeps the SDK process available to answer metadata control requests such as `reloadSkills()` without creating a user turn. A hard 15 second deadline aborts the iterator and closes the query, including when initialization resolves after the deadline.

## Sources

- [Claude Agent SDK: Extend agents with skills and dispatch commands](https://code.claude.com/docs/en/agent-sdk/slash-commands)
- [Claude Agent SDK: Configure permissions](https://code.claude.com/docs/en/agent-sdk/permissions)
- [Claude Agent SDK: TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)
- Installed package declarations: `@anthropic-ai/claude-agent-sdk@0.3.302`, especially `sdk.d.ts` (`Options`, `PermissionMode`, `ModelInfo`, `SlashCommand`, `Query` and `Settings`) and `sdk-tools.d.ts` (`EffortLevel`).
