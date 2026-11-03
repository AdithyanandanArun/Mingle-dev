# Single-session Autonomous workflow: browser acceptance fixture

`node scripts/session-workflow-browser-acceptance.mjs` checks the new Autonomous workflow UI (see [single-session-workflow.md](single-session-workflow.md)) in Chromium. It runs the real `Composer` and `SessionWorkflowPanel` with the real Zustand store, bootstrapped through `refreshNow()` without `init()`.

## Boundary and safety

- The page is labelled **Example workspace · fixture data only**. Projects, sessions, workflows, attachments and helpers are synthetic.
- A disposable Vite server binds an ephemeral loopback port. Every `/api/**` request is answered by the script; `/ws` and `/ws/**` are intercepted and counted. Unlisted API paths return 404 and fail the test, except the Git bar's `/repository` and `/github` reads, which are expected to be unavailable. Requests to a non-loopback host fail the test.
- No provider, model, cloud service, credential or installed runtime is touched. Nothing here is a paid task.
- The mocked workflow routes parse bodies with the real `StartSessionWorkflowSchema`, `WorkflowControlSchema` and `ResumeSessionWorkflowSchema` (loaded through Vite), so a malformed or non-strict request is rejected as the server would. The mock also applies the documented `expectedVersion` check (409), checks that attachments and context references belong to the session, and requires explicit extra turns/time to resume an exhausted budget. These server rules come from the mock, not the production service. The production service has its own tests.
- Each test uses a fresh browser context (clean storage), `reducedMotion: 'reduce'` unless stated, and fails on page errors, console errors, external requests or WebSocket attempts.

## Running

Requires an existing dependency install (no install or download), the repository's Playwright, and Chromium:

```
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/home/adithyan/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome \
  node scripts/session-workflow-browser-acceptance.mjs
```

Screenshots go to `$TMPDIR/mingle-session-workflow-acceptance-<pid>/`, or to `SESSION_WORKFLOW_ACCEPTANCE_OUTPUT` when set. The last line is JSON with pass/fail counts, the output directory and screenshot paths. Exit code is 1 on any failure.

## Coverage (28 test runs)

| Area | What is asserted |
| --- | --- |
| Opt-in, ordinary chat | No panel, no budget setup and Autonomous not pressed by default; model/effort/approval/Plan editable; a native effort change PATCHes; a normal send posts `{content, intent:'normal'}` to `/messages` and never to `/workflow`. |
| Start | Selected turn and time budgets, the goal, original `attachmentIds` and file `contextRefs` are sent; untouched budgets are sent explicitly (8 / 240 / 2); the draft, chips and tray clear on acceptance. |
| Plan exclusion | Plan and Autonomous cannot both be on; budget setup follows Autonomous; Plan still sends `intent:'plan'`; a `/command` in Autonomous mode is refused locally and the draft is kept. |
| Rejected start | A 409 keeps the draft, budgets, attachment and context; retrying sends an identical request. |
| Locking | While a goal runs (in a turn and between turns) model, effort, approval, Plan and Autonomous are disabled with no PATCH; an explicit human send still goes to `/messages`. |
| Paused / stopped | A paused goal releases native controls, disables Autonomous with guidance, sends ordinary chat to `/messages` (the goal stays paused, no second-goal 409) and keeps Resume. Autonomous armed before a paused goal arrives is reset. After Stop a new goal can start. |
| Pause / Stop | Buttons send the visible `expectedVersion`; the Composer stop button stops the workflow (not `/interrupt`). |
| Stale 409 | Pause and Resume stale conflicts show the server message, refresh, perform exactly one request, and the next action uses the refreshed version. |
| Resume | `additionalTurns` only for an exhausted turn budget; `extendMinutes` only for an expired deadline (240, or the remainder to the 1,440-minute cap, labelled in hours or minutes); both with a hint; plain Resume sends no extension; a fully used 50-turn or 24-hour cap is disabled with a hint. |
| Waiting | A native question reads Waiting for you, explains where to answer, and offers no Resume. Between turns the label counts only the session's own running subagents (Waiting for N subagents), or Continuing your goal when none run. Ten pause reasons are stated plainly with the agent summary. |
| Completion | Label is Agent reported completion; a finished goal starts collapsed with no actions; no host-authored verified/accepted/published wording; Review changes opens the Changes pane. |
| Restore | Running, paused-after-restart and a later bootstrap snapshot render after load; page load performs no mutation. |
| Session switching | Workflow, drafts, attachments, project label and actions stay with their own session; an in-flight pause (made stale) neither leaks its result or error into another session nor replays. |
| Responsive, keyboard, motion | At 390 and 900 px there is no horizontal overflow, controls stay in the viewport and actions are at least 28 px tall; a keyboard-only run covers toggle, budget, start, heading collapse and Pause with visible focus; the live pulse is off under reduced motion and on otherwise. |

## Screenshots

`01-setup-desktop`, `02-started-desktop`, `03-waiting-desktop`, `04-completed-desktop`, `10/11/12-{running,paused,setup}-{390,900}` and `13-keyboard-390`.

## Limits

- A fixture and a mocked server, not an end-to-end run: it does not prove the production service's turn scheduling, the finish tool, restart recovery, native approvals, or a real provider response.
- Live WebSocket updates are not exercised; snapshots arrive through the bootstrap refresh path.
- Chromium only; no screen-reader run. Accessibility checks are role/name/state, keyboard operation and focus visibility.
- The repository status bar reads are intentionally unavailable, so the Git bar is not asserted.
- The fixture composer is not the full app shell (no Chat transcript, sidebar or task views).
