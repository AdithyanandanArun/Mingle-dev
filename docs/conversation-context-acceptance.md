# Context ring and automatic composer acceptance

Source checks completed on 2026-11-15. See [conversation context](conversation-context.md) for the user flow and the [implementation contract](implementation-contract.md) for provider and permission boundaries.

## Implemented behavior

- Provider-scoped context reports persist independently of billing totals and survive restart. Identity changes and successful native compaction invalidate old readings; unknown data never becomes a fabricated percentage.
- The composer ring changes color strictly above 70% and 90%. Hover/click/keyboard details show reported usage, estimates and native compact/cancel controls. Drafts survive completed, failed and unsupported compaction. Group controls address one recipient's native conversation.
- Explicit planning and keep-working requests route without a mode dropdown. Read-only plans, bounded workflow limits, queued planning requests, native commands, paused goals, attachments, selected context and memory exclusions retain their existing boundaries. Group continuation remains under its coordinator.
- Agents can request durable questions during normal conversation as well as planning. Read-only runs receive only the question MCP tool; secret answers remain excluded from stored question answers and expired capabilities reject access.
- The toolbar model control is capped independently of its popup. Popup direction, reduced motion, viewport changes, search, keyboard focus and restoration are covered.

## Verification

- `pnpm typecheck`: passed across contracts, desktop, server and web; final web check also passed after the group-routing correction.
- `pnpm build`: passed production web build and server typecheck.
- Backend Vitest, serial files: **847 passed, one skipped**, across 112 files.
- Web Vitest, serial files: **245 passed**, across 30 files.
- `node scripts/session-workflow-browser-acceptance.mjs`: **34 scenarios passed**, including ordinary and planning send paths, bounded autonomy, pause/resume/stop, queues, failed-send preservation, attachments/context, memory exclusions, keyboard control, session isolation, mobile layout and provider-error recovery.
- `node scripts/context-usage-browser-acceptance.mjs`: passed threshold edges, hover details, native compact, operation-scoped cancellation, unknown and busy states, focus restoration, draft retention, session switching, unsupported/failure feedback and viewport bounds.
- `node scripts/model-picker-browser-acceptance.mjs`: passed independent trigger/popup widths, search, provider choices, keyboard, focus restoration, narrow layout, resizing and scrolling. Mobile composer screenshots were inspected.
- `pnpm smoke`: passed real local HTTP/WebSocket, SQLite restart, worktree isolation, Git diff, task dependencies, path/origin rejection and PTY checks without model calls.
- `git diff --check`: passed. Implementation and regression coverage are separated into dated, scoped commits.

## Limits

Provider/MCP behavior uses scripted adapters and local fixtures, and browser fixtures are explicitly marked Example. No paid inference, production cloud mutation, release publication or desktop installation was performed for this feature. Live provider context reporting and native compaction still need testing against each user's runtime. Codex/Claude readings are labelled estimates, and missing provider capacity remains unreported.

Automatic routing deliberately recognizes explicit leading directives rather than arbitrary semantic intent. Ambiguous requests remain normal chat. Native permissions, plan approval and autonomous limits remain authoritative.
