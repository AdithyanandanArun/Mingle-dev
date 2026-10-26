# Mingle onboarding

Start here to use Mingle or set up a development checkout. For the project's current state and handoff notes, read [CONTEXT.md](CONTEXT.md). Repository contributors must also follow [AGENTS.md](AGENTS.md).

## Install the desktop app

Download a package from [GitHub releases](https://github.com/AdithyanandanArun/Mingle-dev/releases). The [0.0.2 release](https://github.com/AdithyanandanArun/Mingle-dev/releases/tag/v0.0.2) contains a Debian/Ubuntu amd64 `.deb`, a Windows x64 setup `.exe`, a Linux x64 `.tar.gz`, and their SHA-256 files.

- Debian/Ubuntu: install the downloaded package with `sudo apt install ./mingle_0.0.2_amd64.deb`.
- Windows: run `mingle-0.0.2-win32-x64-setup.exe`. Installation is per-user. The installer is unsigned, so Windows may show an unknown-publisher prompt.
- Arch Linux: see [desktop distribution](docs/desktop-distribution.md) for building the package locally. An AUR package has not been published.

Launch **Mingle** from the application menu. Desktop packages include Electron, Node, the local server and the UI. Coding-provider tools and accounts are configured separately. Signing in to a Mingle account is optional for local development sessions.

## Set up a source checkout

Requirements: Git, Node **24.13 or later**, and pnpm **11.26.0**, as declared in [package.json](package.json). Native `node-pty` compilation may require Python and a C++ build toolchain if no compatible prebuilt binary is available. Windows installer builds additionally need NSIS 3.11; Debian package builds run on Debian/Ubuntu.

```sh
git clone https://github.com/AdithyanandanArun/Mingle-dev.git
cd Mingle-dev
pnpm install --frozen-lockfile
pnpm dev
```

Open **http://127.0.0.1:5173**. Vite serves the UI and proxies the local API on **127.0.0.1:4310**. Stop development processes with Ctrl+C.

To serve a built UI with the local API:

```sh
pnpm build
pnpm start
```

Open **http://127.0.0.1:4310**. To use the Electron development shell instead:

```sh
pnpm build
pnpm desktop
```

## Configure a provider and start a session

1. Open **Settings → Providers**. Install and authenticate the provider runtime on the same computer and as the same OS user that runs Mingle. Use **Re-check** to inspect actual availability and errors.
2. For Codex, use the separately installed CLI and `codex login`. For Claude Code, use `claude auth login`. For OpenCode, use its provider login flow, `opencode providers login`. Antigravity has an explicit runtime installer and Google sign-in under Providers. See the [provider guide](README.md#provider-setup) for supported modes and differences.
3. Add an existing Git project with at least one commit. Configure its Git user identity before asking an agent to commit. The clearly labeled example workspace is available for exploration and starts no model calls.
4. Create a session and select its provider, model, reasoning effort and permissions. Start with **Supervised** to review tool requests. Sessions use isolated Git worktrees by default; those separate edits but are not OS sandboxes.
5. Send a task with a clear expected result. This starts a real provider run and uses that provider's account/quota. Review proposed changes and checks before committing, pushing or merging.

Use **Add agent** for local Cowork or orchestrated groups. Review each member's provider, model, permissions and workspace before sending work. Creating a group alone starts no inference. See [group sessions](docs/group-sessions.md).

An explicit `ANTHROPIC_API_KEY` in the runtime environment takes precedence over Claude's saved login and uses API billing. Mingle does not automatically load `.env`; [the example configuration](.env.example) documents variables to export through your shell or launcher. Keep actual credentials outside source control.

## Accounts and team collaboration

Open **Settings → Account → Continue with Google** for a Mingle identity and explicit preference sync. This is separate from provider authentication. The configured Google app is In production with basic identity scopes; no tester allowlist is needed.

Settings → Account shows whether sign-in is saved securely. On Linux, Mingle selects a detected Secret Service/KWallet backend automatically. If the keyring is locked, unlock it and choose **Retry secure storage**; this saves the current login without restarting. A missing keyring or a Node/web-only runtime keeps sign-in in memory and explains the required setup. See [account storage](docs/accounts.md#desktop-credential-storage).

For the project-first collaboration flow, open a Git project and choose **Add teammates** beside **Add agent**. Enter the teammate's email and send the invitation. They open **Join project** from the email, open installed Mingle, sign in with the invited account, select/clone the project locally and choose their first provider/model. They can choose a provider-supported permission mode, then select which local agents to share and the maximum team permission they allow. The agents are created idle; joining and sharing do not start model runs.

The leader opens an ordinary session, chooses **Add agents**, and selects a teammate’s published agent alongside local providers. Adding a teammate converts that session into the project’s shared team session. Teammates open the same session from their sidebar and use its normal group conversation; there is no separate chat workspace to configure. An unaddressed message goes through the group’s selected coordination mode; an explicit @handle targets that agent. Mingle prepares team/project/device binding behind the scenes and limits invitation-based pairing to the leader and joining device. Existing **Settings → Team workspace** controls remain available for advanced setup and diagnostics.

Email delivery needs the reviewed collaboration migration, deployed delivery function, sender secrets and a published HTTPS join page. A missing setup is shown explicitly; the app does not claim an email was sent. See [project teammates and sender setup](docs/project-teammates.md). The reviewed setup is deployed. On 2026-10-24, live Gmail receipt, installed Linux invitation opening, exact-account join and leader visibility of the recipient’s idle agent were verified using two accounts on one computer; see the [dated acceptance record](docs/project-collaboration-acceptance.md).
Remote execution is reserved for exceptional recovery: qualifying local quota/provider failure with exhausted local alternatives, or an explicit human request to recover unpublished committed work. The destination owner must approve the exact request and provider use. Git transfer, merge, push and restricted remote commands have their own approvals. Uncommitted edits are not transferred by recovery. Follow the [two-device runbook](docs/distributed-workspaces.md); complete physical-device acceptance remains outstanding.

## Verify a change

From the repository root, after dependency installation:

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm smoke
```

These are the normal [Validate workflow](.github/workflows/ci.yml) checks. Automated checks do not run paid model tasks. The smoke harness uses disposable data and exercises real local HTTP/WebSocket, terminal, Git and restart behavior.

For distributed UI changes, also run:

```sh
node --test apps/web/src/components/distributed/*.test.mjs
node scripts/distributed-browser-acceptance.mjs
```

The browser harness needs an available Chromium executable and free ports 4310 and 4451. `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` selects an existing browser. Positive cloud scenarios use explicitly labeled fixtures; passing them does not prove live OAuth or cross-device delivery. See [acceptance evidence](docs/distributed-acceptance.md).

## Data and common setup problems

Source runs use ignored `.mingle/`, or reuse an existing `.relay/` store for continuity. Desktop runs use their selected Electron user-data directory. `MINGLE_DATA_DIR` overrides the workspace data path; legacy `RELAY_*` variables remain fallbacks. The SQLite file retains the historical name `relay.sqlite`. Do not delete application data as a cleanup step: it may contain worktrees with unmerged work.

| Symptom | First check |
| --- | --- |
| Provider unavailable or login failed | Settings → Providers; executable path and login under the same OS user. |
| New isolated session cannot start | The project is a Git repository with an initial commit. |
| Development UI/API cannot bind | Ports 5173 and 4310 are free; another Mingle instance may already use them. |
| Native terminal fails | Supported Node version and native build prerequisites; reinstall dependencies for the current platform if they were copied from another one. |
| Team creation/loading fails | Verified account, correct Supabase connection, applied migrations and the surfaced error; [deployment runbook](docs/distributed-workspaces.md). |
| Sign-in disappears on exit | Whether secure desktop storage/keyring is available; memory-only storage is displayed explicitly. |

For implementation work, read [the contracts](packages/contracts/src/index.ts) and [implementation contract](docs/implementation-contract.md) before editing. Use an isolated worktree, keep commits scoped, and get the owner's permission before pushing or publishing.
