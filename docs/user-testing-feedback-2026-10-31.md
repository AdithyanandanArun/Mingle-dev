# User testing feedback — 2026-10-31

Feedback from real user testing of Mingle 0.0.9. Each item is checked off once it is fixed, verified and committed on `feature/user-testing-fixes`.

## UI

- [ ] **The UI could be a lot better.** Polish the main screens (sidebar, chat, composer, team session, settings): spacing, hierarchy, empty states and clearer actions.

## Team sessions

- [ ] **Adding more agents is hard once the first ones are added.** After the initial setup there is no easy way to add another agent to a shared team session.
- [ ] **The orchestrator can't take its controls back after running out.** When the orchestrator's provider hits its usage limit and later becomes available again, it doesn't regain its orchestrator role and tools.

## Single-agent chat: subagents

- [ ] **Subagents are hard to call.** Make it easy to ask for a subagent from a normal chat, for example with a clear composer action or an `@` mention.
- [ ] **Show subagents in a side bubble.** List each running subagent next to the chat, with its provider and model.
- [ ] **Show "Waiting for subagent to finish"** in the task strip while the main agent waits on a subagent.
- [ ] **Resume automatically.** When a subagent finishes, the main agent picks up the result and carries on by itself.

## Composer

- [ ] **Steer while it runs.** Allow sending a message while the agent is working; it is queued and delivered at the next opportunity.
- [ ] **Send now.** Offer a way to send a queued message straight away (interrupt and deliver it immediately).

## Projects and worktrees

- [ ] **Normal folders with isolated worktrees on.** In a folder that isn't a Git repository, creating a session and chatting should still work. Instead of refusing, offer to initialise the folder as a Git repository, and optionally create a new GitHub repository for it.

## Providers

- [ ] **OpenCode didn't work for one person**, with either OpenCode v1 or v2.
- [ ] **Antigravity didn't work even after installing its runtime.**

## Credentials on Linux

- [ ] **Multiple keyrings on Arch (KWallet and GNOME Keyring).** Mingle didn't pick the one actually in use, couldn't save credentials, and kept saying "KWallet". Detect the active Secret Service correctly, and let the person choose when more than one is available.
