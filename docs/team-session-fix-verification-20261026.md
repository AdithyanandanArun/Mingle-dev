# Team session fixes — 26 October 2026

This follows the frozen [coffee-shop test report](coffee-shop-full-test-20261026.md). That report records the original failures; it is not a passing test of these changes. The final assembled source tested below is `e267556`, including the host-authorized run-state updates and compatibility repair for existing pending messages.

## Member conversation and shared state

- Joined projects open the shared conversation when the leader's group becomes available. Existing joined profiles migrate when no explicit preference exists. Deliberately choosing the local agent remains authoritative across refresh and reload.
- The member receives a bounded, host-device-authenticated projection of public group routing, assignments, delivery/task state and result metadata. Private native transcripts are excluded. The provider reads the current locally owned group without synchronizing or changing its roster.
- Opening shared history seeds an idle host's current view. Member history relays exclude host-authored hidden views, preserving their device-authority boundary.
- Shared entries and chat messages form one chronological timeline. Stable source identities suppress exact mirrors; matching text alone does not suppress another message.
- A live check found that member-origin human messages also need their durable `teamchat-<message-id>` routing identity. The projection now resolves that identity within the exact group and project/team binding. Wrong-project and wrong-author records do not supply mirror identities.
- Individual-agent inspection folds internal delivery context. Returning to the shared conversation preserves its unsent draft. Test drafts were cleared without submitting them.

## Verification completed

| Check | Result |
| --- | --- |
| Server, web and contracts TypeScript checks | Passed |
| Assembled server suite | **392 passed across 52 files**, including the two-app encrypted mailbox/artifact workflow; 105.35 seconds in the final isolated run |
| Team-chat and group-view focused tests before the final mirror correction | 22 passed |
| Group-view tests after the member-origin correction | 9 passed, including project and author isolation |
| Web unit tests | 5 passed across 3 files |
| Production web build | Passed |
| Project collaboration browser acceptance | 10 passed; explicitly intercepted Example cloud/auth/email responses and FakeProviders |
| Real member default selection | Shared group opened from a legacy local-agent preference with no explicit opt-out |
| Real shared metadata | Both test accounts received the same group ID, two assignments, current-leads routing and the recorded result |
| Real chronological timeline | Timestamp order verified in the rendered shared-browser conversation |
| Real member-origin mirror | Existing confirmation rendered once after the corrected signed view arrived |
| Real agent inspection and draft continuity | Individual inspection worked; raw delivery instructions were collapsed; returning retained the unsent shared draft |
| Restarted account storage | Both test accounts restored as signed-in using OS-encrypted storage |
| Existing pending message repair | Member row changed from running to completed after shared history sync; both accounts retained exactly one owner-signed reply |
| No provider replay during repair | Run counts remained 16 on the host and 9 on the member; zero active runs on either profile |

## Artifact and recovery corrections

The owner exports committed scoped files before forwarding `team_artifact`; the host imports into an isolated ref before its exact path/blob/handoff checks. Assignment prompts distinguish the current work from quoted coordinator instructions. Clarification turns remain reply-only, and coordinator guidance uses durable result-review wakeups.

The host now records its own delivery base/task/scope and checks the whole transferred history before a handoff or integration. Interrupted MCP transfers recheck authority at asynchronous boundaries and discard unpublished data; published handoffs remain durable. Verified imported artifacts can become subsequent remote task inputs without requiring them to be on the human checkout's HEAD. The scope regression also rejects case-only renames outside an exact assigned Git path.

Completion notifications require a stable delivery identity and reuse a saved signed reply on replay. The regression covers concurrent calls, a new service on the same database, changed-content rejection and separate deliveries answering the same request. Delayed roster publications cannot override a newer withdrawal because publication order is persisted across restart.

Further review found that the host must not author as a remote agent at all. The owner device now publishes its signed reply, and the host independently clears request completion. Owner terminal recovery also recreates a reply from the saved result if the process stopped before its first chat post. A changed owner is fenced; signing failure does not hold back the terminal status. The focused recovery regression and two-app owner-signature regression pass, and the final review found no blocker in that recovery path.

## Live artifact and completion continuation

The shared-browser run created only `handoff-verification.md` in the disposable coffee project. Artifact `art_56d415c6bcef4632`, task `tsk_281dd42f045a437e`, commit `2c9e88ea937c4383f49262c6d672496e400b1a78` was imported at **05:42:39 UTC** and published at **05:42:49 UTC**, before the owner provider ended at **05:43:00 UTC**. Terminal integration then completed and the host notification intent cleared. The website's `index.html` and `styles.css` were unchanged.

The live test's second assignment was invalid: it requested that the original producer consume an artifact addressed to the coordinator. Handoffs are recipient-specific and cannot target the same source session. That queued test assignment was explicitly cancelled and the agent resumed; this is **not** counted as a live forwarding pass. The automated two-app case uses two distinct remote agents, transfers the first agent's published input and checks the successor's integrated base revision.

A separate no-edit request from the member composer received exactly one `OWNER_SIGNED_COMPLETION_OK` reply on each device, signed by the producing owner's registered device. The host stored the source request as completed with its notification intent cleared; no provider runs remained active. This exposed a display defect: the member's original human-message row still said running because the host's forwarded full-message update correctly failed direct author-device validation. Dedicated `teamchat.run-state` updates now accept monotonic state changes only from the bound project host, without changing the original author, body or signature. The distinct `chat-state:` idempotency namespace avoids collisions with older full-message updates.

For profiles already affected, history requests include up to 100 unique active human-message IDs from the bound project. The host returns only matching signed human rows within the existing history-response bound; receiving devices verify provenance and update state without replaying orchestration. In the final shared-browser check, the original member row changed from running to completed, both accounts retained exactly one owner-signed reply, and their provider run counts remained 16 and 9 respectively. Both profiles were idle, with empty composers.

Two overlapping full-suite runs each reported 389/390, timing out at the 15-second multi-stage handoff wait while another full suite and native test profiles were starting. The same test passed alone, and the isolated full suite then passed all 390 tests. Production timeout values were not increased. Diagnostics now prioritize dispatch/input-transfer state instead of long successful tool payloads.

The live checks used the shared T3 browser and two separate native Electron test profiles on one Linux computer, with existing real Google accounts and cloud mailbox delivery. The UI, restart and final compatibility-repair checks submitted no new provider tasks. The explicitly authorized live artifact and no-edit completion continuations used real provider inference; automatic tests used fixtures and no paid inference. The final result remains labeled as a response, with no task acceptance implied.

Local logs include `/tmp/mingle-final-legacy-state-full-server-20261026.log`, `/tmp/mingle-final-host-state-full-server-20261026.log`, `/tmp/mingle-final-serial-full-server-20261026.log`, `/tmp/mingle-final-forwarding-diagnostic.log`, `/tmp/mingle-owner-reply-recovery-regression.log`, `/tmp/mingle-final-seam-scope-tests.log`, `/tmp/mingle-member-human-mirror-browser.log`, `/tmp/mingle-member-human-mirror-web-tests.log`, and `/tmp/mingle-member-human-mirror-web-build.log`. Sanitized live evidence is under `/home/adithyan/.cache/mingle-coffee-test-20261026/early-artifact-final-evidence.json`, `owner-signed-completion-final-evidence.json`, and `legacy-status-repair-final-evidence.json`. Fixture screenshots are under `/tmp/mingle-project-collaboration-acceptance-11315/`.

## Final verification and limits

The fixes are integrated. The final combined suite and server/contracts/web typechecks passed, and the existing member conversation repaired through the shared browser without another provider run. The web unit tests and production build passed before the last server/contracts-only sync-request follow-up; the final web typecheck also passed after it. Live provider tests remain separate from automatic tests.

No push, deployment or system package installation was performed. Different physical devices/networks and Windows/macOS behavior are outside this Linux evidence.
