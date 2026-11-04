# Single-agent refinements

Approved 4 November 2026. Base: Mingle 0.1.0 (`f27ea09`). Implement in the order below, with a focused local commit and relevant checks for each item. Publication is separate.

Keep native conversations, provider availability and permissions truthful. Preserve autonomous budgets, user stops, approval boundaries and uncertainty about side effects. Use flat neutral surfaces, restrained motion and reduced-motion support. Tests use disposable examples and fake providers; no paid inference or cloud writes.

| Order | Improvement | Status | Acceptance |
| --- | --- | --- | --- |
| 1 | Simplify composer | Complete | One Chat / Plan / Autonomous selector; model and permissions stay visible; advanced effort, tier and goal budgets move into a keyboard-accessible popover. Existing commands, attachments, context, paused-goal chat and configuration locks still work. |
| 2 | Unify progress | Complete | One expandable progress surface combines current task, goal, helpers and run state. Pause/Stop/Resume, checklist and helper navigation remain accessible without stacked status panels. |
| 3 | Long conversations | Complete | Older session history loads progressively; offscreen rendering stays bounded or deferred. Loading history preserves the reader's anchor and live output, run/tool/change placement and text accessibility. |
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

### 1 — Composer

- Replaced independent mode toggles with one accessible Chat / Plan / Autonomous choice. Model and permissions remain on the toolbar.
- Moved reasoning/service tier and new-goal budgets into Advanced conversation settings; local `/effort` and `/tier` commands open the same controls.
- Preserved routing, attachments, context, drafts, paused-goal chat and active configuration locks. Fixed nested choice-menu dismissal and keyboard focus during popover positioning.
- Checks: web TypeScript; all 96 web unit tests; 29 local workflow/composer browser checks, including 390px/900px layouts and keyboard settings. Screenshots inspected. All browser data was explicitly labelled Example; no model or cloud calls.

### 2 — Unified progress

- Added one collapsed progress disclosure for standalone sessions. Goals show their current task, status, helper count, turn budget and Pause/Stop/Resume controls; expanded details contain the goal, checklist and helper navigation.
- Embedded helper lists no longer float over the transcript or add a second expansion control. Standalone helper drill-down retains its Back action and the parent draft.
- Checks: web TypeScript and 96 unit tests; 30 workflow/composer browser checks, 7 full-app task-strip checks and 8 full-app automatic-subagent checks. Rechecked the final integrated goal layout at 390px/900px and inspected screenshots after fixing inherited floating-rail geometry. Local Example fixtures only.

### 3 — Long conversations

- Standalone sessions open on the bootstrap's newest 300 messages. A "Load older messages" control at the top pages `GET /api/sessions/:id/messages?before=<oldest displayed id>&limit=101` on demand only (one extra row answers "is there more" without another request; no idle polling). Loading, failure (with the server's message and Retry) and "Start of conversation" are shown from real state. A session whose bootstrap holds fewer than 300 messages is complete, so it shows no control.
- Older history lives in `apps/web/src/lib/sessionHistory.ts`, outside the refresh store. It is held contiguously (`older ++ bootstrap window`), the bootstrap's copy always wins, messages that slide out of the bootstrap window while a session is open are kept in place, and a window that cannot be proven contiguous (300+ new messages unseen) discards the held history with a visible notice instead of showing a hole. Requests are fenced by an abort signal, an epoch and the cursor they were issued for, so session switches, unmounts, late responses, overlapping clicks and duplicate pages cannot reorder, duplicate or resurrect history.
- Memory: at most 6 sessions are remembered; a session that is left keeps its 400 nearest older messages (the rest reload on demand); an open session stops offering more at 5,000 older messages and says so.
- The server now answers an unknown, empty or other-session `before` cursor with 404 (same message for both, no identity leak) rather than silently returning the newest page; the store returns nothing for a foreign cursor.
- Prepending keeps the reader on the same row (anchor restored after the insert and while deferred rows settle), does not pin to the bottom or count as new output, adds no arrival animation, and silences the conversation live region briefly so assistive technology is not asked to read out the prepended rows. Run activity, tool and change cards are placed by the existing layout, so runs whose messages were older than the window (previously listed after the latest message) move under their own user messages as their history loads.
- Rendering: rows use `content-visibility: auto` with remembered intrinsic heights. This is deferred layout/paint, **not virtualization**: React and Markdown still mount every loaded row and all text stays in the DOM, so selection, copy, native find (which reveals skipped rows), focus and screen readers keep working. A column observer keeps the view pinned while rows take their real height, and "Latest" now jumps instantly for that reason (a smooth scroll targeted a height that changed underneath it).
- Checks: web TypeScript and 116 unit tests (20 new history tests); server TypeScript and 6 new cursor tests; browser acceptance `node scripts/session-history-browser-acceptance.mjs` (real SessionPane over an Example 600-turn transcript, three consecutive passes) plus the existing render-count, 30 workflow/composer, 7 status-bar and 8 automatic-subagent browser checks. Fixture evidence on Chromium: 300 mounted rows, 300 skipped initially; with all 1,210 messages loaded 1,205 rows skip layout (36.5k DOM nodes remain mounted); eight forced full-column relayouts cost ~130–165 ms with deferral vs ~375–435 ms with everything rendered; anchor shift after prepending 0.2 px; 11 requests to load the whole history with 100 messages each. The full parallel server suite shows load-related timeouts in unrelated distributed/team tests that all pass when run alone.
- Limitations: pages carry messages only, so run/tool/change cards exist only for the runs the bootstrap already holds (newest 200); older user messages load without run cards. The 300-message window is duplicated in the web client (a server test fails if it changes). Browsers without `content-visibility` render every row (correct, no saving). `innerText` of a skipped row is empty (selection, `textContent` and find still see it). Measurements are fixture evidence on one machine, not a latency guarantee.
