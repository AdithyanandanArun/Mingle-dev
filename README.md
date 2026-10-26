# Mingle

A local development workspace for independent coding-agent sessions. Mingle is the current product name; the original product vision is retained as historical context in [the product vision](docs/vision.md).

This repository includes an original React workspace, a Node runtime, persistent sessions and events, isolated Git worktrees, provider adapters, task dependencies, artifact handoffs and an Electron desktop app with Linux and Windows packaging. Opt-in distributed team services are implemented; complete live two-device acceptance remains outstanding. Voice orchestration remains a later milestone.

New here? Start with [onboarding and setup](ONBOARDING.md). Developers and coding agents can read [current project context](CONTEXT.md) for architecture, implementation status, validation evidence and next steps.

## Desktop app (Linux and Windows x64)

Mingle is intended to be installed as a desktop application. Download available installers from [GitHub releases](https://github.com/AdithyanandanArun/Mingle-dev/releases). Debian/Ubuntu uses an amd64 `.deb`; Windows uses a per-user `.exe` installer. Temporary download prereleases are labeled separately from stable releases. The Windows installer is unsigned. There is no AUR entry yet. Existing `relay-workspace-*` artifacts are pre-rename builds and keep their original filenames.

Build Debian packages with `pnpm package:deb` on Debian/Ubuntu, or Windows installers with `pnpm package:windows` on Windows x64 with NSIS 3.11 available. Both have manual GitHub Actions workflows with native runtime and installation checks; see [desktop distribution](docs/desktop-distribution.md).

Build the installable package on Arch with `base-devel`, Node and pnpm available:

```sh
pnpm install --frozen-lockfile
pnpm package:arch
```

Then explicitly install it:

```sh
sudo pacman -U ./release/mingle-bin-0.0.3-1-x86_64.pkg.tar.zst
```

Open **Mingle** from the application menu, or run `mingle`. The package includes Electron, Node, the compiled local server and the UI. It starts and stops its own local server; users do not need a source checkout, pnpm or a manually started development server. Install and sign in to Codex or Claude separately; Antigravity has a runtime installer under **Settings → Providers**. Data lives in the selected Electron user-data directory, outside `/opt/mingle`.

`yay -S mingle-bin` will work only after an AUR entry is published. The new package declares compatibility replacement metadata for `relay-workspace-bin`. See [desktop distribution](docs/desktop-distribution.md) for builds, downloads, updates and release prerequisites.

## Run locally

Use Node **24.13 or later**, Git and pnpm **11.26**. Native terminal support may require a C++ build toolchain and Python when a prebuilt `node-pty` binary is unavailable.

```sh
pnpm install
pnpm dev
```

Open **http://127.0.0.1:5173**. The local API listens on port **4310**. The clearly labeled example workspace contains local files, idle sessions and a sample dependency workflow; it starts no model calls. Add your own existing Git project to work on real code.

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm smoke
pnpm start
```

`pnpm start` serves the built workspace and API together at **http://127.0.0.1:4310**. Tests use local fixtures rather than paid inference.

## Mingle account

Open **Settings → Account → Continue with Google** to sign in and explicitly save or restore appearance and model defaults across devices. The current Google app is in testing mode with the owner's account allowed. Desktop sign-ins use the OS keyring when available; Node/web-only sessions are memory-only. Local projects remain usable while signed out. Repository data, provider credentials and permission grants are not synchronized. Team collaboration is available in **Settings → Team workspace** after the distributed schema is deployed. See [Google accounts and preferences](docs/accounts.md).


## Team workspaces and linked devices

Open an existing Git project and choose **Add teammates** beside **Add agent** to invite someone by email. The teammate opens the project invitation in Mingle, chooses a local checkout or explicitly clones the repository, and selects their first provider/model. The project agent controls show local and shared teammate agents together. Joining starts no model run. See [project teammates and sender setup](docs/project-teammates.md) for deployment requirements and validation limits.

**Settings → Team workspace** supports team invitations, shared projects, reciprocal device fingerprint linking, selected Claude/Codex/OpenCode agents, shared messages and tasks, availability, recovery approvals, Git bundle transfers, and restricted Git inspection commands. The Agents view maps the reported developers, devices, agents and tasks. Shared recovery activity also appears in its source group conversation.

Remote execution is reserved for exceptional recovery. Automatic suggestions require a recorded local quota/provider failure and exhausted local alternatives. A human may explicitly request recovery of unpublished committed work. The destination owner reviews the exact request and separately consents to provider use, unknown quota when applicable, and progress sharing. Recovery never copies uncommitted edits: commit and review the source work, transfer it through approved Git sync, and prepare a clean destination session first. Push and merge require separate local approvals.

Messages use signed, encrypted outbound cloud mailboxes with durable retries and duplicate suppression. Interrupted dispatches remain uncertain and require human recovery. The dedicated deployment's team migration and one-account team creation/loading were verified on 2026-10-22. Production OAuth access and a complete live two-device/provider acceptance run remain outstanding; tests do not apply cloud migrations. See the [acceptance evidence](docs/distributed-acceptance.md) and [deployment and verification runbook](docs/distributed-workspaces.md).

## Provider setup

**Codex:** install the supported Codex CLI and authenticate it yourself with `codex login`. Mingle talks to its documented app-server protocol, using the conversation identifier for later turns.

**Claude:** the adapter uses the official Claude Agent SDK with your existing local Claude Code login. Run `claude auth login` in a terminal on the same machine and as the same OS user that starts Mingle, then use **Settings → Re-check**. Mingle asks `claude auth status --json` for login status; it never reads, copies or stores credential files. If Settings selects a different executable than your shell, use that full executable path for login.

Alternatively, set `ANTHROPIC_API_KEY` in the environment that starts Mingle. An explicit API key takes precedence over the saved login and uses API billing. Credentials are not entered into the browser. A copied `.env` file is not automatically loaded; export the variable in your shell or use your process manager's environment configuration.

**Antigravity:** open **Settings → Providers → Install Antigravity runtime**, then **Sign in with Google**. Mingle uses Google's official ACP runtime, including its required companion harness, rather than the Python SDK or a third-party CLI adapter. Google owns the browser login and credentials. Installation does not start a model turn. You can also select an existing ACP executable with its companion alongside it; the interactive `agy` executable is a different program.

Antigravity models and reasoning choices are discovered during explicit sign-in. **Antigravity default / Native default** keeps Google's native selection. Supervised, Auto-accept edits and Full access map to its reported modes; native Auto review is not advertised. Background checks initialize the protocol without opening a login browser. Native history import, explicit skill attachments and a custom compaction threshold are not currently available for this provider. See [Antigravity integration](docs/provider-antigravity.md) for protocol details and limitations.

**OpenCode:** install OpenCode and sign in to the providers you want with its own `opencode providers login`; Mingle starts `opencode acp` per run and never reads OpenCode's credential files. Settings → Providers → Re-check lists the models OpenCode itself reports (`provider/model`), each model's native variants as reasoning effort (**Native default** leaves the variant unset), and native slash commands for the session's folder, all without sending a prompt. Supervised, Auto-accept edits and Full access are enforced through per-run OpenCode permission rules; Auto is unavailable. Native history import, usage/quota, Mingle's skill picker and the compaction threshold are unsupported and say so. See [docs/provider-opencode.md](docs/provider-opencode.md).

An installed executable does not establish authentication or access to every model. Settings show executable and login diagnostics and allow path overrides. Model access, expired credentials and quota errors remain visible when a session runs.

See [provider research](docs/provider-research.md) for the T3 architecture investigation, protocol sources and provider access assumptions.

## Workspace behavior

**New Session** creates and selects a session immediately from the sidebar toolbar. Set its default provider, model and effort in **Settings → General → New sessions**. Settings opens as a full page with General, Project, Providers, Agents & orchestration, Browser and Appearance sections. Each provider remembers its own default model. Existing sessions keep their choices, and their model and effort can be changed in the composer between runs. A provider conversation is retained when switching models within that provider; use a new session to switch providers after a conversation has started.

The composer reads each model's supported reasoning levels and speed options from its provider. Its combined reasoning/speed popover shows the reported defaults. Permission choices include **Supervised**, **Auto-accept edits**, **Auto** and **Full access**, where supported. Settings also saves a default service tier. Explicit unsupported choices fail before a run; inherited defaults adapt when changing models.

Type `/` for commands or `$` for installed skills; use arrows to navigate, Enter/Tab to select and Escape to dismiss. `/skills` opens the skill picker, `/model`, `/effort`, `/tier` and `/permissions` open the corresponding controls, `/diff` opens Changes, and `/status` shows current choices. Claude's own reported slash commands are available alongside Mingle commands. Selected Codex skills use native skill inputs; Claude dispatches one selected skill per message. See [provider feature coverage](docs/provider-feature-parity.md) for provider differences and remaining work.

`/usage` opens account usage without starting a model turn, including reported session/weekly limits, remaining percentages, reset dates and countdowns. Codex also reports native credit balances and available reset grants with expiry dates. Claude shows the quota windows its SDK supplies; unavailable balances or reset-grant counts are labeled as not reported. Conversation token/cost totals appear separately. Refresh is explicit, with a short cache and cooldown; opening usage never spends a reset.

Right-click a session, use its three-dot action button, or press **Shift+F10** on a focused session to pin/unpin, rename, mark read/unread, copy its name/ID/branch/folder, open Project settings, or archive it. Pins and manual unread markers are saved across reloads; opening a session marks it read. Project settings lets you change the display name and copy its folder path. Archiving asks for confirmation and keeps the session’s data, worktree and branch. Active sessions must be interrupted before archiving.

Git worktrees are the default; a repository needs an initial commit before Mingle can create one. Settings also offers an explicit project-folder workspace default. A worktree separates file edits and is not an operating-system sandbox. The context pane and terminal start closed; open them when needed. Tasks, activity and the agent map are available under **More** in the sidebar.

New runs show a live elapsed timer and tool/category summaries, followed by a final worked duration. Expand the activity row for commands, inputs/output, exit codes and provider-reported child calls. Activity and timing survive reloads; older text-only history retains its available details.

Finished runs also show a compact changed-files card below their response, with added/deleted line totals, expandable folders and **Open diff**. The viewer displays that run's saved, read-only patch, including edits committed during the run. These are net workspace changes between run start and finish; concurrent edits in a shared folder may be included. Existing history without a captured snapshot is left unchanged. Unavailable snapshots and truncated lists/patches are identified explicitly.

Tasks include an owner, prerequisites and acceptance criteria. A successful assigned run enters review. Artifact handoffs identify a committed file and revision, record an event and add context for the receiving session's next turn. Handoffs do not merge branches or silently launch inference.

Use the file pane to inspect and edit permitted project files, the changes pane for Git diffs, and the terminal for an interactive shell in the selected local workspace. The app is intended for a trusted local user and binds to loopback; exposing it through a network tunnel is not a supported team collaboration mode.

New local runs use the ignored `.mingle/` directory unless an existing `.relay/` store is present; then Mingle reuses it in place. Use `MINGLE_DATA_DIR` to override the path. Legacy `RELAY_DATA_DIR` remains accepted when `MINGLE_DATA_DIR` is unset. Worktrees and provider conversation references are retained; deleting application data is not a supported cleanup procedure for repositories with unmerged work. See [rename and data continuity](docs/mingle-rename.md) before changing old data roots.

## Group conversations

Use **Add agent** in a session to choose **Cowork**, **Orchestrated** with a separate coordinator, or **Current agent leads** with the existing session as orchestrator. Preview each new agent's provider, model, effort, permissions and isolated workspace before adding it. The separate-orchestrator choice also offers Keep/Change for the existing worker's configuration. Creating a group starts no inference.

A shared timeline keeps each member's responses, tools, timing, approvals and file changes distinct. Use `@claude1`, `@codex1`, `@antigravity1`, `@opencode1` or the recipient picker to address a member. Without a recipient, Cowork lets one peer split the request before the others edit; either coordinated mode sends it to its orchestrator. Providers receive scoped team tools for actual assignments, peer questions, progress and verified artifact references. Tasks follow those assignments automatically.

**Settings → Agents & orchestration** saves coordinator/worker defaults and delegation bounds. **Members** opens per-agent settings, queue state, stop/resume and mode/limit controls. Pause holds new scheduling; Stop also interrupts active runs. Queued work stays paused after a server restart until explicitly resumed. Target a supported provider command or skill with `@handle /command arguments` or `@handle $skill arguments`; Mingle validates it against that member's current native catalog before dispatch. See [chat attachments and native actions](docs/chat-attachments-and-native-actions.md) for provider limits.

See [group setup, communication and recovery](docs/group-sessions.md). A [live Codex/OpenCode integration proof](docs/group-session-live-proof.md) demonstrated automatic delivery of a committed contract, dependent work, integration and checks. This is evidence for one local Linux task; Claude interoperability and broader recovery remain unverified.

## Repository controls and automatic tracking

The composer footer shows the actual checkout and branch. Use **Commit** to select files and write a message, or its menu for explicit push and pull request actions. GitHub checks and recent workflow runs are read-only and labelled by commit; Mingle does not run or rerun workflows. GitHub access uses your existing `gh` CLI login.

Opening a project scans its structure and explicit checklist/TODO items. Tasks also follow new session work requests and native provider plans. Activity and Agent Map update from real repository and session records, including in a single session. Automatic updates preserve fields you edit; completed provider work goes to Review. See [sources, controls and limits](docs/repository-automation.md).

## Shared browser and context

Open **Browser** in a session’s context pane to use a Mingle-managed Chromium or explicitly connect a running Chromium browser with its existing logins and tabs. Providers receive tools for that same browser. Take control to browse yourself, then release it to the agent. Configure browser defaults in **Settings → Browser** and supported automatic context compaction in **Settings → General → Context**. See [setup, controls and current limits](docs/shared-browser.md).

## Desktop development shell

```sh
pnpm build
pnpm desktop
```

The Electron launcher starts the same Node server on a selected loopback port. It uses the local Node installation, configurable with `MINGLE_NODE_EXECUTABLE` (legacy `RELAY_NODE_EXECUTABLE` is used only when the new variable is unset), and stores state under Electron's selected user-data directory. This is a development launcher; signed installers and update delivery are future release work.

## Project documents

- [Onboarding and setup](ONBOARDING.md)
- [Current project context and handoff](CONTEXT.md)
- [Original vision](docs/vision.md)
- [Product and interaction specification](docs/product-experience.md)
- [Minimal workspace revision and T3 UI references](docs/ui-direction.md)
- [Architecture decisions](docs/architecture.md)
- [Implementation contract](docs/implementation-contract.md)
- [Provider research](docs/provider-research.md)
- [Milestones and acceptance evidence](docs/roadmap.md)
- [Observed validation and remaining limits](docs/validation.md)
- [Mingle rename and data continuity](docs/mingle-rename.md)

The implementation is original. T3 Code is an architectural research reference and is not a source-code dependency. No license grant has been selected for this project yet.
