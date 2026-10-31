# User testing feedback — 2026-10-31

Feedback from real user testing of Mingle 0.0.9. Each item is checked off once it is fixed, verified and committed on `feature/user-testing-fixes`.

## UI

- [x] **The UI could be a lot better.** Polish the main screens (sidebar, chat, composer, team session, settings): spacing, hierarchy, empty states and clearer actions.
  - Compact header controls, clearer sidebar session hierarchy, responsive settings tabs and a wider subagent rail are committed. Delegated children appear under their parent instead of duplicating top-level sessions; the automatic-subagent browser checks pass at desktop and narrow widths.

## Team sessions

- [x] **Adding more agents is hard once the first ones are added.** After the initial setup there is no easy way to add another agent to a shared team session.
  - Cause: the server refused to add an agent (yours or a teammate's) whenever the orchestrator was busy, which in a working team is most of the time. New agents now join idle while work runs. "Add agent" is always in the team header and at the end of the Agents card. The dialog suggests the next free handle and the provider and model used last, and explains when an agent on a teammate's device needs their consent.
- [x] **The orchestrator can't take its controls back after running out.** When the orchestrator's provider hits its usage limit and later becomes available again, it doesn't regain its orchestrator role and tools.
  - Cause: when the usage limit hit, the original orchestrator was handed off and "held", and nothing ever gave the role back. Mingle now remembers the original orchestrator. Once its cooldown has passed and its provider is available, it takes the role back automatically, or when you click "Restore @lead". If the stand-in is mid-task, the restore waits until it finishes. The team chat says "@lead is back and has resumed orchestrating", and the orchestrator instructions and team tools return with the role (covered by a test).

## Single-agent chat: subagents

- [x] **Automatic model-spawned subagents.** Per the corrected requirement, the main model can delegate from an ordinary chat, whether the user requests subagents or the model chooses to use them. There is no manual launcher or locally intercepted `/subagent` command. Native Claude/Codex/OpenCode activity and model-callable Mingle delegation drive the UI.
- [x] **Show subagents in a side bubble.** List each running subagent next to the chat, with its provider and model.
- [x] **Show "Waiting for subagent to finish"** in the task strip while the main agent waits on a subagent.
- [x] **Resume automatically.** When a subagent finishes, the main agent picks up the result and carries on by itself. Tests cover model-initiated MCP delegation, queued results, idle queue drain and restart interruption. With automatic restart resume disabled, recovery records a note without starting model work.

## Composer

- [x] **Steer while it runs.** Allow sending a message while the agent is working; it is queued and delivered at the next opportunity.
  - The composer stays usable while the agent works. With Codex, the message reaches the running turn straight away (`turn/steer`) and appears in the chat. With other providers, or when a message has attachments or skills, it is queued (saved across restarts) and sent automatically when the run finishes, keeping its attachments and skills. Queued messages appear above the composer with Edit, Remove and Send now.
  - Limitation: Claude can't receive a message mid-turn yet, because Mingle's Claude adapter sends each turn as one prompt, so Claude messages wait in the queue. Codex steering is covered by tests with a fake Codex, not yet tried against a live model.
- [x] **Send now.** Offer a way to send a queued message straight away (interrupt and deliver it immediately).
  - "Send now" on a queued message, or Ctrl/Cmd+Shift+Enter while the agent runs, interrupts the run, waits for it to finish cleaning up and sends that message first. If sending fails, the message goes back to the front of the queue with a notice.

## Projects and worktrees

- [x] **Normal folders with isolated worktrees on.** In a folder that isn't a Git repository, creating a session and chatting should still work. Instead of refusing, offer to initialise the folder as a Git repository, and optionally create a new GitHub repository for it.
  - Sessions now work directly in a folder that isn't a Git repository (or has no commits yet), with a short note instead of an error. The project bar shows **Set up Git** and **Set up Git and create a GitHub repo**. These run `git init` on `main`, add a starter `.gitignore` only if there isn't one, keep `.env` files and private keys out (templates like `.env.example` stay), skip files over 50 MB, and make an initial commit with your Git identity (or your Mingle account if Git has none). The GitHub option uses GitHub CLI (`gh repo create … --push`); if `gh` isn't installed or signed in, it says how to fix that. Sessions created afterwards get isolated worktrees as usual.

## Providers

- [x] **OpenCode didn't work for one person**, with either OpenCode v1 or v2.
  - Likely cause: Mingle opened from the app menu doesn't see the `PATH` that shell config files add, and OpenCode's installer puts it in `~/.opencode/bin`. Mingle now reads the login shell's `PATH` at startup and also searches common install folders (OpenCode, Bun, Volta, nvm, pnpm, Cargo, Homebrew, npm's prefix). Current OpenCode (1.19.5; there is no OpenCode 2 on npm) passes the connection probe. If it still fails, the error now names the step that failed and shows the last lines of OpenCode's output. We had no logs from the tester, so this fixes the likely cause rather than a confirmed one.
- [x] **Antigravity didn't work even after installing its runtime.**
  - Same `PATH` fix. After installing, Mingle checks again and the setup card shows either "Ready" or the exact next step, instead of a bare "Installed".

## Credentials on Linux

- [x] **Multiple keyrings on Arch (KWallet and GNOME Keyring).** Mingle didn't pick the one actually in use, couldn't save credentials, and kept saying "KWallet". Detect the active Secret Service correctly, and let the person choose when more than one is available.
  - Done: Mingle now prefers the keyring that is actually running, checks it with a real encrypt/decrypt test, remembers what worked, and retries once with the other keyring if it fails. On the first launch after upgrading, a key saved by an older version must still decrypt, or Mingle switches back. Settings → Account shows where credentials are stored and lets you choose: Automatic, GNOME Keyring or KWallet.
