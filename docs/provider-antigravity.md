# Google Antigravity provider

Mingle uses Google's official **Antigravity ACP** runtime as an independent provider. It does not substitute the headless `agy` CLI, an editor process, a third party wrapper, or API-billed Python SDK calls for Google account sessions.

## Installation and sign-in

Settings offers an explicit runtime installer. The adapter accepts its configured executable or finds the exact ACP executable on `PATH` or `~/.local/bin`. The launch files are `agy_acp_server.par` plus `localharness_external` on Linux/macOS, and their `.exe` counterparts on Windows. Both must be readable/executable as appropriate. An explicit setting is authoritative; Mingle does not search private editor caches or silently select another installation. Linux uses the official registry's `--uid=` launch argument.

Background detection sends only `initialize`. A successful connection establishes the runtime's identity, protocol and advertised capabilities; it does not establish Google authentication. No background model session or login is started. Settings' **Sign in with Google** explicitly calls native `authenticate` with `oauth-personal`. Google owns the OAuth flow, loopback callback, token exchange and account storage. Mingle never reads/copies credential files, extracts OAuth tokens, or persists login URLs. Cancellation and a five-minute deadline terminate sign-in. **Refresh models and commands** uses existing native credentials with a 90-second deadline; if Google requests login, Mingle aborts discovery and asks the user to sign in instead of opening a browser.

For explicit sign-in, Mingle delegates the packaged runtime's Python browser opener through the documented `BROWSER` command override. A short Node no-op lets native authentication print its own authorization link without blocking inside a desktop launcher. Mingle captures that exact native stderr message across bounded stream chunks, accepts only Google HTTPS OAuth authorization URLs with native loopback redirects, and requests the host's default browser using an argv array. Login links are removed before diagnostics are retained. No OAuth implementation or Google authentication code is copied into Mingle.

Settings reports **Starting Google sign-in**, browser waiting only after a native link arrives, then **Loading Antigravity models** after native authentication succeeds. Cached native credentials can proceed directly to loading models without opening a browser. While waiting, **Open Google sign-in** is available through Electron's external-link handler if automatic launch fails. The validated link exists only in the active in-memory auth job and UI state; it is cleared on model loading, cancellation, completion, failure, replacement or shutdown. Opener failures are reported without including the URL. Browser processes are never terminated when setup is canceled.

### Linux startup compatibility

Some desktop launch environments pass a zero `RLIMIT_RTTIME` soft/hard limit to descendants. On the affected Arch desktop, the pinned Google ACP 1.4.1 binary exited with SIGKILL before initialization in roughly two seconds; launching the identical binary from a user service with `LimitRTTIME=infinity` completed initialization and closed cleanly on stdin EOF. This reproduced independently of browser authentication, with no kernel or cgroup OOM event.

Mingle checks its inherited Linux realtime timeout before launching the real provider. Only the zero-limit case uses a unique, temporary `systemd-run --user` service with a normal realtime timeout. Other Linux launches, macOS and Windows retain their direct launch path. The service inherits the intended working directory and provider environment; environment values are not command arguments, removed credential variables remain excluded, and direct stdin/stdout/stderr pipes preserve ACP transport and private login links. The service is collected after exit. Cancellation stops its whole control group, including the native harness, before retiring the local proxy. This changes no system-wide limits, files, scheduler priority or browser settings. A missing user service manager is reported as a setup failure.

After sign-in or explicit catalog refresh, a metadata session obtains the advertised models and measures each bounded model selector's reasoning choices without submitting a prompt. Discovery waits for the asynchronous native `available_commands_update`; it does not depend on a first paid turn to populate the command picker. A missing command catalog also triggers a metadata-only discovery when that session's picker loads. Other model families are not assigned the current model's reasoning controls. Unmeasured choices expose **Native default** only.

Public model names, measured reasoning choices and command descriptions survive app restarts in a validated cache under the operating system's user cache directory (`~/.cache/Relay/antigravity` by default on Linux). Files are private, bounded to 512 KiB, atomically replaced, expire after seven days, and are scoped to the executable fingerprint and native account configuration context. Unknown native payload fields are discarded. Credentials, authorization URLs, conversation content and authentication state are never cached. Displayed cached choices do not establish current authentication or quota; explicit refresh and real run setup check native access again.

Metadata and quota operations each use a new private, empty temporary workspace, with mode `0700` on POSIX. They do not discover project instructions, skills or MCP configuration from the shared temporary directory. Mingle removes the workspace after the native child stops; a failed startup or unconfirmed shutdown can leave the private directory in place.

## Independent runs and controls

Each run has one child process and one independent native conversation. New sessions use `session/new`. Existing IDs use advertised `session/resume`, or `session/load` with historical notifications suppressed. A resume failure never starts a replacement conversation. Actual completion comes from the `session/prompt` response, not an invented stream event.

Mingle maps supported permission policies to advertised native modes:

| Mingle control | Antigravity mode |
| --- | --- |
| Supervised | `default` — native permission prompt flow |
| Auto-accept edits | `auto_edit` |
| Full access | `yolo` |

Auto is unavailable. Google retains its workspace and administrator controls; Full access does not remove those boundaries. Whenever native ACP requests a decision, Mingle returns only the selected one-time permission option. It does not persist Allow Always grants. Unsupported or unconfirmed modes fail before a model prompt. Changes to the effective model, explicit effort or permission mode during a turn stop that turn visibly.

Model `default` preserves the native selected model. Its display name includes the reported model, and its effort menu includes that model's measured reasoning choices. Effort `none` preserves native reasoning rather than disabling it; its label includes the reported default level when available, for example **Default (High)**. Explicit model selection is applied before reading that model's reasoning selector. The adapter validates every effective setting returned by native configuration updates. Non-standard service tiers and Mingle-selected skills fail explicitly. Mingle's configurable compaction percentage is not exposed by this ACP runtime; runs explain that native context management remains in effect.

## Browser and team tools

Mingle browser, team and progress tools connect independently through per-session MCP configuration, including on resume. When the runtime advertises HTTP MCP, the adapter uses that transport. Otherwise, the ACP stdio baseline runs a small local Node bridge that forwards JSON-RPC to Mingle's local HTTP MCP endpoints. The bridge is written under the private Mingle data directory, and its endpoint and bearer capability are supplied only through the bridge process environment; Electron's Node executable is launched with `ELECTRON_RUN_AS_NODE=1` when applicable. Capabilities never travel in argv, prompts, global MCP files or project configuration. The six exact team tool identities and browser tools use their authenticated host gateways for authorization; other native permission requests go to Mingle's approval UI.

The inspected Antigravity ACP 1.4.1 interface exposes generic session tool calls but no native subagent spawn identity or child-session/parent-tool relationship. Mingle records provider tool activity normally and does not infer subagent launches or child conversations from generic tools.

Tool identity uses ACP's actual `_meta.mcp` fields. Tool lifecycle records retain native invocation IDs, input, output and any reported command, directory or exit code. An approval is not presented as a completed tool. Native plans use their reported content/status entries. Historical replay and provider-private thoughts are omitted. Context-window `usage_update` values are not presented as input/output token totals. Mingle does not invent subprocess relationships, cost or token metrics.

Every emitted string and error is scrubbed for literal run capabilities and configured Google API keys. OAuth query details are removed from diagnostics. Output, RPC lines, stderr, metadata and quota reports are bounded. Abort sends native cancellation and stops the child; POSIX descendants share its process group. Windows uses process tree termination for the real runtime. An unresponsive run keeps its session locked until its process exits.

## Catalog, quota and history boundaries

The command catalog uses only metadata reported by native ACP. Empty discovery and unsupported Mingle skill selection have explicit notices. Native conversation import is currently unsupported: listing returns an empty result and notice; reading returns a specific error. Neither operation falls through to Claude.

Quota lookup requires authentication previously checked in this Mingle process. It uses a separate maintenance session, preserving the user's active native conversation. In the inspected Google ACP **1.4.1** release, the advertised literal `/usage` command is intercepted before model inference. Mingle checks that exact version and command before invoking it; other versions return an unavailable notice. No quota prompt is sent to an unverified version.

Reported percentages retain their model group and native window label. Reset timestamps are parsed only from explicit UTC/ISO text; formatted native resets have minute precision. Unsupported credit balances, redemption grants, window lengths and other unknown values remain unknown. A bounded native report accompanies partial/unavailable results. Maintenance sessions can remain in Google's native session store; they contain no model conversation.

## Research and validation

The official registry identified Google LLC's ACP 1.4.1 release. The Linux archive inspected outside the repository had SHA-256 `2e37012ceb2a5c7fc7309b6e6596234fb637ee3c62a5199f65d4cbe777871384` and contained the two launch files above. A real initialize-only inspection reported `antigravity-acp` 1.4.1, protocol 1, HTTP MCP, load/resume and session listing support.

The public API definitions shipped in that archive were inspected to establish session, configuration, permission, MCP and native quota shapes. The initial integration exercised initialization only. This was interface research; no Google implementation code was copied into Mingle. Synthetic adapter tests now verify HTTP-versus-stdio MCP setup; they do not exercise a live Antigravity model turn or native child-agent behavior.

During the 2026-10-20 sign-in fix, the installed Arch desktop was rebuilt and reinstalled. Direct startup reproduced SIGKILL with inherited realtime timeout `0:0`; the compatibility launch initialized version 1.4.1 in about 1.8 seconds and closed cleanly on EOF. The final installed backend reported `authenticated`, cleared its login link, and returned native model metadata including `gemini-3.8-flash`. No transient provider setup unit remained afterward. The installed backend matched staged bundle SHA-256 `7449574e6bc42f91cc17eadbb0046936c892c3bbe9b9dd48c5d2e863519e6149`; the Arch package SHA-256 was `1811175b700fff0618bc3433db74fc59d166fa818adb06d63a13d20640784d14`. Type checking and the production package build passed. This confirms authentication and metadata retrieval, not prompt streaming, tool execution or permission roundtrips; no inference prompt was submitted.

Primary references:

- [Official Google ACP registry entry](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json)
- [Google Antigravity CLI and its distinct headless interface](https://www.antigravity.google/docs/cli/headless/)
- [Google SDK authentication and API billing setup](https://www.antigravity.google/docs/sdk/overview/)
- [ACP initialization](https://agentclientprotocol.com/protocol/v1/initialization)
- [ACP session setup, resume and HTTP MCP](https://agentclientprotocol.com/protocol/v1/session-setup)
- [ACP session configuration](https://agentclientprotocol.com/protocol/v1/session-config-options)
- [ACP tool calls and one-time permission responses](https://agentclientprotocol.com/protocol/v1/tool-calls)
- [Python browser launch behavior and the BROWSER override](https://docs.python.org/3/library/webbrowser.html)
- [Upstream Linux startup and inherited realtime-limit reproduction](https://github.com/google-antigravity/antigravity-cli/issues/1112)
- [systemd-run user services, direct pipes and environment forwarding](https://www.freedesktop.org/software/systemd/man/latest/systemd-run.html)

### Catalog correction, 2026-10-20

An actual metadata-only session on the installed Google ACP 1.4.1 runtime reported `Gemini 3.8 Flash`, reasoning `low`, `medium`, `high`, current native reasoning `high`, and commands `/plan`, `/logout`, `/usage`. No inference prompt was submitted. The default sentinel now retains these measured choices instead of displaying only a generic native option. Catalog refresh completed and wrote the validated public cache for subsequent Mingle processes. This does not validate model inference, browser tools, or permission roundtrips.
