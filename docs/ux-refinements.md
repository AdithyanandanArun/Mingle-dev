# Everyday UX refinements

The November 2026 refinement pass improves interaction and recovery while retaining the original neutral dark/light theme tokens. It adds no appearance preference, database migration, provider operation or automatic model run.

## Shared controls and navigation

Buttons expose busy and unavailable state without dropping caller-owned descriptions or busy indicators. Icon buttons retain custom tooltips and show busy feedback. Switches associate their explanations with their controls. Segmented choices retain a usable Tab entry when a saved choice is missing/disabled; arrows, Home and End move both focus and selection.

Select menus expose their current value and optional read-only state, cycle repeated-letter typeahead from the active option, skip disabled options and keep their positioning synchronized with viewport changes. Context menus support typeahead and wait for their positioned portal to become visible before taking keyboard focus. Dialogs recover escaped Tab focus, skip hidden/inert autofocus targets and keep footer controls usable at narrow widths.

The command menu skips unavailable commands, avoids executing an IME confirmation, and announces empty searches. Context tabs support Home/End and the pane closes on Escape while restoring its opener. Settings sections support arrow/Home/End navigation. The sidebar brings the selected session into view on selection/open changes, and the header announces the active workspace breadcrumb.

## Conversation reading and queued messages

Code blocks have a visible toolbar, an optional line-wrap control, keyboard-focusable output, and copy success/failure feedback. Failed clipboard access never claims success; the user can select/copy manually or retry. Copying preserves the original code independently of wrapping.

Ctrl/Cmd+F focuses Find in the visible conversation, while leaving editor, terminal and modal find handling alone. Search still covers loaded messages only. It reports no matches, the total count and the first-100-result limit. Enter and Shift+Enter cycle that displayed set while keeping input focus. Closing or changing the search fences delayed jumps so they cannot steal focus afterward. Bookmarks retain their existing ID-only local storage behavior.

Queued-message editors autofocus, support Ctrl/Cmd+Enter to save and Escape to cancel, and retain focus on return. Accepting the latest text after a conflict also updates the optimistic concurrency baseline; a later save can then succeed against that version. The server remains the authority for conflict handling. Internal subagent handoffs remain excluded from the editable queue.

## Files, editor and terminal

The explorer has a single roving Tab entry, directory-aware left/right arrows, Home/End navigation and accessible nesting metadata. Refresh failures retain browsable rows with Retry. Requests are scoped to the mounted tree and latest per-directory request, preventing older responses from replacing newer listings.

Editor save failures remain visible inline with a retry action and preserve the draft. Reload is withheld during a save. Closing/reopening the same path fences earlier load/save responses; editing during a save preserves the newer draft while only the saved snapshot becomes the original.

Clear terminal output clears local retained display output and scrollback through terminal escape sequences. It does not send input to the shell, start/stop a process or reset terminal modes. Restart and Stop remain separate explicit controls.

## Validation

- `pnpm typecheck` passed across the workspace.
- `pnpm build` passed for the production web client and server.
- Web Vitest: 26 files, 224 tests passed, including six editor recovery/race cases and a terminal-bus check.
- `node scripts/workspace-ux-browser-acceptance.mjs`: 40 checks passed with the real controls, file explorer, conversation navigation, queue, terminal renderer, editor/Monaco and command palette. API responses and shell state are explicitly labelled Example fixtures; all API paths are mocked and external requests fail the test. Screenshots cover narrow code/dialog layouts, light theme and the editor.
- Existing conversation-navigation (16), composer activity (17), automatic subagent (13), appearance, settings usage and model-picker browser suites passed. The conversation suite scopes its bookmark announcement assertion separately from the new search status.

No paid inference, host terminal job, cloud write, native installation or public release is part of these checks. Browser fixture evidence does not establish native Electron behavior on every operating system.
