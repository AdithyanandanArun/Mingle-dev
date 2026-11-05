# CLI updates, session titles and appearance acceptance

Reviewed locally on Linux on 2026-11-06. This covers the source changes after `351284d`, not a new desktop release or an upgrade of this computer's provider CLIs.

## Behavior checked

- Codex, Claude Code and OpenCode offer an explicit private managed update when the detected stable installation lacks a verified native self-updater. Package selection and target paths are server-owned. Validation precedes transactional activation and retention of the previous preference. Disposable executable fixtures exercise failed staging, wrong versions, escaped symlinks, repeat upgrades, shutdown, offline metadata and durable-save failures.
- Executable changes and restoration reject busy providers. HTTP checks cover an active scripted turn, atomic multi-provider rejection, lease release, independent appearance changes and restoring automatic discovery.
- Generated standalone sessions use the first eligible task for a local title. Tests cover Markdown, Unicode, bounded length, canonicalized secrets, code blocks, manual numeric names, one-time assignment, legacy recovery and human workflow starts.
- Subtle color applies to dark and light themes. The real Settings page and store preserve the choice across reloads, restore the exact previous monochrome tokens, support keyboard use and keep the existing palette on a failed save. Screenshots were inspected at desktop and 390px widths.

## Checks

- `pnpm --filter @mingle/server exec vitest run --maxWorkers=1`: 832 passed and one skipped in 109 files at `fbec46d`. The subsequent npm configuration fix passed 35 focused provider service/runtime checks, including a real read-only npm configuration query.
- `pnpm typecheck`: passed across contracts, desktop, server and web.
- `pnpm --filter @mingle/web exec vitest run`: 217 passed in 24 files.
- `node scripts/provider-updates-browser-acceptance.mjs`: passed native/manual/pinned guidance, managed actions for all three CLIs, busy rejection and retry, original-preference restore, rejected restore, partial refresh errors and narrow layout.
- `node scripts/appearance-browser-acceptance.mjs`: passed dark/light palettes, exact monochrome restoration, persistence, keyboard controls, failed-save recovery and narrow layout.
- `pnpm build`: passed web production build and server typecheck.
- `pnpm smoke`: passed HTTP/WebSocket, SQLite restart, worktree isolation, Git diff, task DAG, origin/path rejection and PTY without model calls.

## Limits

All provider-update installations in these checks use disposable package fixtures; none upgrade host CLIs or start paid inference. A read-only probe also exercises the production npm config flags with separate private user, global and project layers; it installs nothing. Actual package download and provider login behavior are not established by these checks. Managed CLI installs require Node/npm and are offered on Linux/macOS; Windows retains supported native updates or manual instructions. No physical macOS or Windows check was performed. Antigravity remains separately checksum-pinned.

Older manually chosen numeric session names without recorded rename evidence are indistinguishable from generated placeholders. Modern explicit names and renames have durable ownership. The title is a short local task label, not a model-generated conversation summary. Appearance can be returned to the original palette through Settings → Appearance → Monochrome.
