# Single-agent refinements

Approved 4 November 2026. Base: Mingle 0.1.0 (`f27ea09`). Implement in the order below, with a focused local commit and relevant checks for each item. Publication is separate.

Keep native conversations, provider availability and permissions truthful. Preserve autonomous budgets, user stops, approval boundaries and uncertainty about side effects. Use flat neutral surfaces, restrained motion and reduced-motion support. Tests use disposable examples and fake providers; no paid inference or cloud writes.

| Order | Improvement | Status | Acceptance |
| --- | --- | --- | --- |
| 1 | Simplify composer | Pending | One Chat / Plan / Autonomous selector; model and permissions stay visible; advanced effort, tier and goal budgets move into a keyboard-accessible popover. Existing commands, attachments, context, paused-goal chat and configuration locks still work. |
| 2 | Unify progress | Pending | One expandable progress surface combines current task, goal, helpers and run state. Pause/Stop/Resume, checklist and helper navigation remain accessible without stacked status panels. |
| 3 | Long conversations | Pending | Older session history loads progressively; offscreen rendering stays bounded or deferred. Loading history preserves the reader's anchor and live output, run/tool/change placement and text accessibility. |
| 4 | Reduce refresh traffic | Pending | Ordinary standalone session events update bounded session data; startup, reconnect and unsupported events retain full recovery snapshots. Measure request/payload counts and preserve gap recovery and all shared-session paths. |
| 5 | Tool output | Pending | Compact factual activity summaries expand into detail. Live truncated snapshots cannot erase fetched full output; newer tool lifecycle fields still update. |
| 6 | Completion review | Pending | One result card separates agent claims from recorded changes, executed checks, failures and remaining work; opens Changes and leaves the task in Review. |
| 7 | Actionable recovery | Pending | Auth, quota, questions, budgets and failures offer appropriate actions. Retry is bounded and only allowed with evidence of safe, undispatched work; denied/refused/uncertain work never retries automatically. |
| 8 | Understandable context | Pending | Inspect attached context, injected memory and reported usage; exclude project memory from the next turn with server-enforced scope. Explain native compaction and unavailable metrics honestly. |
| 9 | Navigation and steering | Pending | Search/jump/bookmark conversation activity and edit queued messages. Clearly distinguish supported live steering from queued delivery. |
| 10 | Interaction polish | Pending | Preserve drafts and reading position across navigation. Verify keyboard controls, narrow layouts and reduced motion without blue accents or gradients. |

## Validation approach

- Run direct TypeScript and focused Vitest/Node checks for substantive changes.
- Exercise real UI components with the repository's documented local browser acceptance harnesses. Label all fixture data as examples.
- Add regression coverage for concurrency, lifecycle, pagination and permission boundaries; avoid tests that simply repeat implementation details.
- Record measurements as fixture evidence, never Internet latency or live-provider guarantees.
- Run integrated web/server checks after the ordered changes and record remaining limitations.

## Progress log

- Roadmap recorded before implementation. Work is isolated on `feature/single-agent-refinements-20261104`.
