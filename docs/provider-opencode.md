# OpenCode provider

Updated 2026-10-20. Mingle runs the user's installed OpenCode through its native Agent Client Protocol server (`opencode acp`, newline-delimited JSON-RPC over stdio). Authentication, quota, model access and credential storage remain OpenCode's own: Mingle never reads OpenCode's auth store, never asks for a key, and never starts a browser login.

Native version inspected: OpenCode **1.19.3** at `/usr/bin/opencode`, ACP protocol version 1.

## Sources

- <https://opencode.ai/docs/acp/> — supported ACP features (custom commands, MCP, agents, permissions) and the documented limitation that built-in `/undo` and `/redo` are unsupported.
- <https://opencode.ai/docs/models/> — model variants (reasoning effort) and `provider_id/model_id` identifiers.
- <https://opencode.ai/docs/cli/> and <https://opencode.ai/docs/server/> — `opencode acp`, `opencode models`, `opencode session delete`, and the HTTP server alternative.
- The upstream OpenCode repository's ACP layer (`packages/cli/src/acp`), read as protocol research to understand option identifiers, permission option kinds and prompt/command routing. No code was copied; the adapter is original.
- Direct no-prompt probes of the installed binary (listed under Verification).

## Why ACP rather than the HTTP server

`opencode serve` is a long-lived shared server. Mingle needs one isolated, killable process per run so permission rules, MCP capabilities and abort cleanup cannot leak between sessions. ACP gives a process Mingle owns (and can signal as a process group), session-scoped MCP registration, `session/request_permission`, `session/cancel`, `session/resume` and native config selectors for model/effort. Even the ACP child starts an HTTP listener (OpenCode's default is port 4096, falling back to a random port), so every child is launched as `opencode acp --hostname 127.0.0.1 --port <unused ephemeral port> --no-mdns` and gets a random per-child `OPENCODE_SERVER_PASSWORD` in its environment (verified: unauthenticated requests receive 401 and ACP still works; the explicit flags bind exactly the requested loopback port). A user's own server settings or running OpenCode server therefore cannot expose or collide with a Mingle child. The generated password is added to Mingle's redaction list for events and tool output.

## Settings

`opencodeExecutable` (optional path or command, empty for discovery) and `defaultOpencodeModel` (`default` means OpenCode's own selection). Discovery looks at the configured path, then `PATH`, `~/.opencode/bin`, `~/.local/bin` and `~/.npm-global/bin`, running `--version` on each candidate; a configured path is never silently replaced. Both fields live in the existing key/value settings table; `sessions.provider` and `runs.provider` are plain TEXT, so no SQL migration was needed.

## Detection and discovery (no inference)

Provider detection (startup and Settings → Re-check) starts `opencode acp` in a **private empty temporary directory**, runs `initialize`, creates one native session (`session/new`, no prompt), reads the model selector, selects each model on that throwaway session to read the variants OpenCode reports for it (a local operation, ~2 ms per model), reads `available_commands_update`, then closes the child (process group escalation) and deletes the throwaway native session with `opencode session delete <id>` using an argv array. Only session IDs created by the probe are deleted, and the delete runs in the probe's private directory, so no project configuration or plugin is discovered for it. `initialize` must also identify the agent as OpenCode, and native session IDs must match `ses_…` on the metadata and run paths. At most two such probes run at once; queueing and native discovery share a 40-second deadline, model inspection has a 12-second budget, and session deletion has a separate 15-second cleanup deadline. Models not inspected in time show Native default only, with a notice. Shutdown cancels waiting probes and waits for active probe cleanup before returning.

Diagnostics are specific: missing/not-executable configured path, failed `--version`, ACP start/initialize failure with a redacted bounded stderr tail, or zero models reported. Availability means "OpenCode starts and reports models". It does **not** claim an account: this machine's OpenCode currently exposes OpenCode's own hosted free models without any stored credentials, and a configured provider's key or quota is only validated by OpenCode at run time.

Detection skips the real probe when a caller injects only discovery dependencies (the same convention as the other providers), so embedded callers never launch a real provider unexpectedly.

## Models and reasoning effort

Model IDs are OpenCode's own `provider/model` values from the ACP `model` config option (for example `opencode/beam-free`); display names are OpenCode's. Mingle adds one sentinel, `default`, which leaves OpenCode's configured/default model unselected. Its entry inherits the name and measured variants of the model OpenCode reports as current (for example "OpenCode/Big Pickle (default)"); this is measured from the private probe directory, so a project `opencode.json` can select a different model, and each run reports the effective model in an info event and validates the requested effort against that model's live options. Nothing is substituted: an unknown model fails before any prompt.

Reasoning effort comes only from native variants. Selecting a model on ACP exposes an `effort` option (category `thought_level`) when the model has variants; its values are the native variant IDs plus a native `default`. Mingle maps these to effort choices per model:

- Mingle `none` = **Native default**, always present, and applied explicitly by selecting the native `default` option (OpenCode reports its first variant as "current" even when none is selected, so Mingle never trusts the displayed current value).
- Native variants keep their IDs when they are valid Mingle effort slugs (`low`, `medium`, `high`, `xhigh`, `max`, `minimal`, …). A native variant literally named `none` (an OpenAI reasoning level, present on one model here) is exposed as `variant-none` because `none` is reserved; other non-slug names are slugged. The mapping is recomputed from the live native options at run time and never from stored data.
- Models without variants offer only Native default.

Model and effort are re-read and verified after each `session/set_config_option`; a mismatch stops the run before the prompt. A model or effort change reported during the run stops the turn (`model_substitution` / `effort_substitution`).

## Permissions

OpenCode's default agent allows every tool without asking, so ACP's own modes cannot express Mingle's policies. Mingle supplies per-run OpenCode permission rules in the child's `OPENCODE_PERMISSION` environment variable (no file is written, nothing global changes). Later rules win.

| Mingle policy | OpenCode rules |
| --- | --- |
| Supervised | `*: ask`; `read` allowed except `.env`-shaped files (ask); `glob`, `grep`, `list`, `lsp`, `todowrite`, `skill` allowed; `edit: ask` |
| Auto-accept edits | Supervised, with `edit: allow` |
| Full access | `*: allow` |
| Auto | Unsupported (OpenCode has no automatic reviewer); not advertised, rejected explicitly |

All policies deny `question`, `plan_enter` and `plan_exit` because ACP has no channel for answering them. Prompts arrive as `session/request_permission` and are forwarded to Mingle approvals. Mingle answers with `allow_once` or `reject_once` only, never an "always" rule. Mingle's own browser/team/progress MCP tool names (`mingle_browser_*`, `mingle_team_*`, `mingle_progress_*`) are allowed by rule and not double-prompted, because those gateways enforce their own approvals and tab ownership. A project `opencode.json` that denies a tool earlier is overridden by the later `*` rule (Supervised becomes ask; Full access is unrestricted by definition).

## Slash commands

The command catalog is fresh and independent of any paid run: `GET /api/sessions/:id/catalog` starts a metadata-only ACP child **in the session's real folder** (the only case where a project's `.opencode` configuration and plugins load for a probe, and only because the user opened that session) (so project commands, `.opencode` configuration and plugins load as they would for OpenCode), reads `available_commands_update`, and deletes the throwaway session. ProviderService caches it for 30 s; Settings → Re-check and the composer's Refresh drop the cache. OpenCode's own skills are exposed by ACP as commands, so they appear under `/`; Mingle's separate `$` skill picker is unavailable and says so.

Only commands the native list advertises are shown. Terminal-only built-ins (`/undo`, `/redo`, and anything absent from the list) are not advertised. Selecting one inserts `/name args`, which is sent as the ACP prompt text; OpenCode's ACP resolves a leading `/name` against its command list and runs the command natively. The run adds an info line (`Running OpenCode command /name`), or states that an unlisted `/name` is being sent as ordinary text. Mingle's local actions (`/model`, `/status`, `/usage`, …) keep precedence over native commands with the same name.

## Conversations, resume and runs

- A run starts `opencode acp` in the session folder and creates `session/new` (or resumes). The native session ID is recorded immediately as `providerSessionId`.
- A stored ID resumes with `session/resume` (or `session/load` with history replay suppressed). A missing/invalid conversation fails with `resume_failed`; Mingle never creates a replacement. Resume was verified across processes.
- Browser, team and progress capabilities register per session as ACP HTTP MCP when `mcpCapabilities.http` is advertised. Otherwise Mingle registers ACP stdio MCP servers that run a small local Node bridge (`process.execPath`, with `ELECTRON_RUN_AS_NODE=1` when the executable is Electron) and forward JSON-RPC to the run-scoped local HTTP endpoints. The bridge is written under the Mingle data directory with private directory/file permissions; its URL and bearer capability are supplied only through the bridge process environment, never argv, prompts or OpenCode configuration. The bridge forwards initialize/notifications and streams JSON or event-stream responses, redacting the capability if a response reflects it. Tokens are scoped to the individual run and revoked afterward. Literal capability tokens and credential-shaped environment values are scrubbed from events and errors.
- Streamed assistant text, tool lifecycle (stable provider IDs, status, command, working directory, exit code when reported, output) and native plan entries become Mingle events. Durations come from Mingle's host clock; ACP reports no process ID, so none is invented. Reasoning chunks are provider-private and not shown.
- OpenCode's native `task` tool is shown as a subagent launch using its reported description/type, prompt, status and final result. Child-session assistant text and tool calls attach to that launch only when the ACP updates identify the parent tool call or a child session ID can be mapped from the task update. ACP does not guarantee this relationship; when it is absent Mingle keeps the launch and final tool result without guessing at child activity.
- Cancellation sends `session/cancel`, waits up to 4 s for OpenCode to unwind, then closes stdin, SIGTERMs and SIGKILLs the child's process group. The adapter promise resolves only after the process has closed, so Mingle's session lock stays held until cleanup finishes; a child that ignores SIGKILL keeps waiting rather than releasing the lock early. Metadata probes bind the caller's abort signal for their whole life, so aborting a probe kills its child and ends `session/new` / model inspection.
- Token usage comes from the `session/prompt` response summary when reported. Cost is not reported over ACP and stays unrecorded.
- Server shutdown stops leftover metadata probes through the provider runtime's optional `close()`.

## Explicit unsupported boundaries

- **History import.** ACP can list sessions (`session/list`), but Mingle has no verified bounded reader for native history. Import lists return a notice and the Import dialog explains it. Continuing a Mingle-created OpenCode session works.
- **Usage/quota.** ACP exposes no account quota, plan or credits; `/usage` says so and shows no invented windows. Cost is unreported.
- **Selected skills.** Mingle's `$` picker/`skills` field is unavailable; native skills are slash commands.
- **Compaction threshold.** Mingle's percentage setting is not exposed by ACP; OpenCode's native compaction remains and each run notes this. `/compact` is not advertised by this version, so it is not offered.
- **Service tiers.** Only Standard.
- **Auto policy.** Unsupported.
- **Unlinked child-session activity.** ACP does not guarantee that OpenCode task subagent streams include a parent tool-call or child-session reference. In that case only the task launch, prompt, status and final result are available in the subagent rail.
- **Terminal/undo/redo commands**, ACP-side file-system and terminal client methods (Mingle advertises neither), image/attachment prompts and OpenCode "question" interactions.

## Verification performed (no inference)

- Workspace TypeScript checks (`contracts`, `server`, `web`) and a production Vite web build.
- Native help/version inspection of `opencode`, `opencode acp`, `opencode models` and `opencode session`. The installed executable is a native binary and no OpenCode source tree was available locally for the `task` tool; child-session linking is implemented only when ACP supplies an explicit parent or session identity.
- Local ACP stdio MCP bridge tests round-trip initialize, `notifications/initialized`, `tools/list` and `tools/call` through a synthetic local HTTP MCP endpoint; verify bearer delivery, response token redaction and HTTP-versus-stdio configuration selection. OpenCode task association tests use synthetic ACP `session/update` messages; no model prompt is sent.
- `initialize` and `session/new` against the installed binary in a private directory: 10 models, native `effort` option and variants, `mode` option, 16 native commands (including `init`, `review` and skills). `session/set_config_option` for model, effort (`default`, invalid values), mode, and unknown model; `session/resume` across processes, with an unknown ID; HTTP MCP header delivery to a local dummy endpoint; permission-rule parsing through `opencode debug agent build` (ruleset only, no credentials printed); loopback server password enforcement.
- Mingle's own `detectOpencode`, `getOpencodeCatalog` and adapter setup path (session creation, model/effort selection, resume, rejection cases, abort and process cleanup) were exercised against the real binary with `session/prompt` intercepted locally, so no model request was sent. Probe-created native sessions were deleted afterward.

Not exercised: any live inference, streamed assistant text, real tool calls, real permission prompts, a real native slash-command execution, cost/usage reporting from a real turn, other providers' credentials, and non-Linux platforms. Those paths follow the documented ACP shapes and the upstream protocol source but have not been observed against a live OpenCode turn.

## Installed desktop delivery, 2026-10-20

Code at `8dcc425` passed `pnpm typecheck` and `pnpm package:arch`. The Arch package was checksum-checked, reinstalled on this device and restarted while Mingle had no active runs or terminals. The installed backend matches the staged bundle SHA-256 `5b18bce9bda4d27057bf8d2db788f169da3f8b9ad76e654b7df9c13058b48079`; package SHA-256 is `db95c744922d0c253ddb79b64c967cc1ae03d1dc3e0fceea4818471c630cecc2`.

The installed health and provider endpoints reported Codex 0.160.1, Claude 2.1.292, Antigravity ACP 1.4.1 and OpenCode 1.19.3 as available. OpenCode returned ten concrete models, per-model native variants and sixteen native commands through no-prompt catalog discovery. Antigravity recovered Gemini 3.8 Flash with low/medium/high reasoning and its native command catalog from the validated cache in a separate process. The collaborative browser's Settings view showed all four providers, the OpenCode executable field and Antigravity's Refresh models and commands action. Existing projects and sessions were retained. No live inference turn or automatic test suite was run.
