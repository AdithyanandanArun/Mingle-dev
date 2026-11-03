# Single-agent autonomy and responsiveness acceptance

Recorded on 2026-11-03. Feature behaviour and API are documented in [single-session-workflow.md](single-session-workflow.md); browser cases are in [single-session-workflow-acceptance.md](single-session-workflow-acceptance.md).

## Behaviour

The standalone composer has an explicit Autonomous mode. Its goal continues in the same native conversation, with a durable task, current permissions, a progress checklist, finite turn/time limits and Pause/Stop/Resume. Ordinary queued human messages take priority. A paused goal permits ordinary chat; a competing assigned task, native command or read-only plan requires pausing the active goal first.

Native turn completion does not finish a goal. The run-scoped finish tool records the agent's report, which applies only after the native turn succeeds. The task remains in Review. Denied approvals, unanswered questions, refusal, failures, uncertainty, stalls and exhausted budgets pause the goal. Restart recovery also pauses it and prevents generic automatic session recovery from starting a duplicate turn. Late helper results cannot start an unbound parent turn after Pause, Stop or completion.

## Verification

- Full server suite at `4e5e4bf`: **100 files, 740 passed, 1 skipped**. Tests use fake providers and disposable local Git remotes.
- After review fix `c9dd79b`: **28 focused tests passed** across workflow service, runtime idle-edge and HTTP/MCP integration. The new regression checks that a separate assigned task cannot bypass a waiting goal's turn budget. The earlier full suite was not rerun for this small guard change.
- Final web suite: **15 files, 96 passed**.
- Contracts, server and web TypeScript checks passed.
- Vite production build passed.
- Autonomous composer browser acceptance: **28 checks passed**. Real Composer, panel, Zustand refresh and strict contract schemas; locally mocked API and socket lifecycle. Includes draft/context/attachment retention, version conflicts, resume grants, session changes, keyboard operation, reduced motion, helper waiting and 390/900 px layouts.
- Existing automatic-subagent browser acceptance: **8 checks passed**. Task-strip acceptance: **7 checks passed**. Their disposable Example fixtures now explicitly select their project instead of relying on the removed starter-workspace default.
- Transcript browser acceptance passed: placement, scroll pinning, reading older messages, new stream-only messages, memoization and compact automatic-prompt disclosures.
- Independent store/transcript review found no blockers. The autonomous lifecycle review found a competing-task budget bypass; the fix and regression were checked in a fresh review, which found no remaining blockers.

## Responsiveness measurements

Deterministic fixture counts, not Internet-latency or live-provider speed claims:

| Scenario | Before | After |
| --- | --- | --- |
| 40 tokens in a 240-message transcript | 9,600 message-row executions | 40 |
| 40 tokens in another session | 9,600 active message-row executions | 0 |
| Identical transcript refetch | 240 message-row executions | 0 |
| 2,000 deltas in one tick | 2,000 store notifications | 1 immediate and at most 1 trailing notification |
| 500 deltas against 300 stored messages | 150,000 message-ID reads | 300 |
| One changed message and tool in a large bootstrap | 1,104 serialization calls / about 3.05 million characters | 1 small persistence serialization / 242 characters |

The transcript harness drives stream buffers directly, so its React counts cover component rendering. Store tests separately exercise the real delta handling, coalescing, reconciliation, gap recovery and refresh scheduler. A continuous event stream now cannot postpone bootstrap refresh forever: the debounce has a two-second maximum wait. No new idle polling is added. Stream batches may add up to 32 ms before publishing a trailing update.

## Evidence and limits

Browser screenshots are labelled Example fixtures, not real model runs:

- Goal controls: `/tmp/mingle-session-workflow-acceptance-543510/`.
- Subagents: `/tmp/mingle-auto-subagent-acceptance-543654/`.
- Task strip: `/tmp/mingle-status-bar-acceptance-545277/`.

No paid inference, live cloud/team writes, credentials, installation or publication were used. The HTTP/MCP tests verify scheduling and authority with fake adapters; they do not establish live-provider reliability. Windows/macOS and native Electron acceptance were not repeated.

Completion remains an agent claim, not independent verification. Defaults are eight total provider turns, four hours and two stalled continuations; hard caps are 50 turns and 24 hours. A provider turn may contain many tool calls. Deadlines include paused time. Resume explicitly grants any needed budget and inspects partial work; queued messages are delivered after that resume turn. Selected native permissions remain authoritative, including the shell capabilities of Full access.
