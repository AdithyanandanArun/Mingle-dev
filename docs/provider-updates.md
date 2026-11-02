# Provider catalogs and CLI updates

Mingle reads model and reasoning choices from the provider's native catalog. A missing or explicitly empty effort catalog exposes only **Native/default**, which omits an effort override. Saved choices remain visible; unsupported explicit choices fail with an actionable error instead of silently selecting a different model. Claude custom model IDs can be entered exactly, but remain unverified until used successfully.

## Startup and notifications

After provider diagnostics become available, Mingle checks small public package manifests for Codex, Claude Code and OpenCode. These requests are bounded to four seconds and 64 KiB, use no provider credentials, and make no model calls. Checks are cached in local SQLite for twelve hours across restarts. There is no repeating idle check. **Settings → Providers → Check again** explicitly refreshes the public metadata.

The notification identifies the provider and release. Dismissing it is persisted for that provider/version, so a newer version can notify again. Status changes arrive through Mingle's existing local event connection. Offline, malformed or missing metadata is shown as unavailable information, never as proof that the CLI is current.

Claude's comparison source is the public `latest` package release. A native `claude update` follows the user's own stable/latest channel, so a successful command is not proof that it installed the public latest release. Mingle reports the version actually observed afterward. Antigravity remains managed through Mingle's checksum-pinned ACP installer; this feature does not unpin or self-update that runtime.

## Explicit updates

**Update** is available only for a recognized, user-owned native installation. Mingle uses fixed argument arrays with no shell: `claude update`, `codex update` (only when the CLI advertises it), or `opencode upgrade`. It rechecks the detected executable and installed version when clicked. Custom executables and package-manager installations instead show copyable instructions for the original installation method; Mingle does not run sudo or overwrite a system package.

A provider maintenance lease refuses updates while its runs, compactions or cancellation cleanup are active, and rejects new work on that provider until the updater exits. Other providers remain usable. Updater output is bounded and redacted, execution has a five-minute limit, and shutdown cancels checks and updater children. Afterward Mingle refreshes native provider diagnostics/catalogs and reports success only when the configured executable reports a newer version. Failed updates stay visible and can be rechecked.

## Validation

Unit and HTTP tests use injected public responses and fake child processes. The runtime test verifies that maintenance excludes starts, compaction and interrupted-but-still-cleaning-up runs. `scripts/provider-updates-browser-acceptance.mjs` uses disposable Example responses to exercise notification, explicit update, busy state, persisted dismissal, a new release, manual installation guidance, offline error and narrow layout. No test updates host CLIs or starts paid inference.

Update commands are based on the official [Claude Code setup documentation](https://code.claude.com/docs/en/setup), [Codex developer commands](https://learn.chatgpt.com/docs/developer-commands), and [OpenCode CLI documentation](https://opencode.ai/docs/cli/).
