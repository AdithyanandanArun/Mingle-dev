# Team session fixes — 26 October 2026

This follows the frozen [coffee-shop test report](coffee-shop-full-test-20261026.md). That report records the original failures; it is not a passing test of these changes. The verification below covers source through `500babb`. Final artifact-boundary integration and the combined server suite are still pending.

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

The live checks used the shared T3 browser and two separate native Electron test profiles on one Linux computer, with existing real Google accounts and cloud mailbox delivery. These checks submitted no new provider tasks. The final result remains accurately labeled as a response, rather than accepted work.

Local logs: `/tmp/mingle-timeline-focused-20261026.log`, `/tmp/mingle-member-human-mirror-focused.log`, `/tmp/mingle-member-human-mirror-browser.log`, `/tmp/mingle-member-human-mirror-web-tests.log`, and `/tmp/mingle-member-human-mirror-web-build.log`. Fixture screenshots are under `/tmp/mingle-project-collaboration-acceptance-11315/`.

## Pending final verification

The separate artifact worker is addressing interruption during transfer, reuse of imported remote artifacts as later assignment inputs, and host-side enforcement of the full transferred history against assignment scope. Those fixes require integration, independent review and the final combined suite before the whole fix request can be called complete. A targeted real-provider artifact handoff remains separate from automatic tests.

No push, deployment or system package installation was performed. Different physical devices/networks and Windows/macOS behavior are outside this Linux evidence.
