# Coffee-shop workflow test — 26 October 2026

Build under test: `926365e`. Implementation was frozen for the final test pass at the user's request. Uncommitted experimental handoff changes in a worker worktree are **excluded**. The final interactions use the shared browser, with two native Electron instances providing separate local servers, account vaults, databases and device identities on one physical Linux computer.

## Outcome

The test run completed through project creation, real invitation/join, remote implementation, a second polish assignment, integration and browser verification. It is **not a clean pass**: the artifact publication defect required an explicit continuation and a documented automatic-transfer workaround. No additional application fixes were integrated during this final pass. The resulting website is at `3dd4c1c209724c457dfd4740a8196132b5077611`, and its worktree is clean.

## Results

| Step | Result | Evidence |
| --- | --- | --- |
| Automated server suite | Pass | 367 tests across 50 files; unchanged backend at this build. |
| Desktop tests | Pass | 41 tests. |
| Web tests/typechecks/build | Pass | Five web tests; server/web/contracts checks and production web build passed. |
| Invitation/join browser acceptance | Pass, fixtures | Eight checks; explicitly named Example cloud responses, no paid inference. |
| Create a real project | Pass | Fresh public Git clone named Ember and Oak Coffee, separate from the Mingle source repository. |
| Send and receive an invitation | Pass, live | Sender account sent through Add teammates; recipient opened the matching Gmail message and HTTPS invitation page. |
| Native invitation routing | Pass with automation limitation | The actual app link reached a cold native join prompt through the OS handler. Shared-browser click automation timed out; `xdg-open` dispatched the link. Original handler was restored. |
| Recipient sign-in and join | Pass, live | Verified invited Google account, explicit clone destination, local provider/model/effort selection and idle agent creation. |
| Owner consent and effective permissions | Pass | Both devices observed Full access settings version 2; recipient consent was granted. |
| Add teammate agent to existing conversation | Pass | Current agent leads mode; local orchestrator and remote worker were visible on both devices. |
| First remote assignment | Pass with role-confusion issue | Real owner-side provider execution in a retained isolated worktree; coordinator clarification was needed. |
| Explicit artifact publication before completion | **Fail** | `team_artifact` could not resolve the owner-side commit in the host source repository. |
| Automatic terminal Git transfer | Pass | Commit `47d9ac739f118dd2ea9249d29ad11794bb9f9981` arrived in the host group worktree, where the lead inspected the actual files. |
| Long-running owner delivery | Pass, observed | A real owner run lasted about 150 seconds without the former 90-second timeout. |
| Sign-in persistence after restart | Pass, live | Both Google identities restored as signed-in through GNOME Keyring; no password or credential files were read. |
| No provider replay on restart | Pass, observed | Both instances remained idle until an explicit continuation request. |
| Shared-browser polish assignment | Pass with workaround | New scoped assignment executed remotely; commit `3dd4c1c` transferred automatically and the lead reviewed it. Explicit artifact publication still failed. |
| Final website browser checks | Pass for tested checks | Final page checked in the shared browser using same-origin responsive frames, menu state/Escape handling, section links and dependency checks. Keyboard/assistive-technology limitations are noted below. |
| Owner pause and queued recovery | Pass, live | Zero owner runs while paused; exactly one queued run after explicit Resume; sharing restored. |
| Shared conversation visibility | Pass, live | Recipient selected the shared Team session and saw original request, polish request and both agents’ updates. |
| Recipient-to-host message and reply | Pass, live | Recipient sent a no-edit confirmation from the shared composer; the host lead answered with the exact final commit and filenames, and the response appeared on the recipient side. |

## Bugs and workflow issues

### 1. Remote artifact publication fails before the owner run finishes — high priority, unresolved

Reproduction: assign a teammate a scoped file change, let its agent commit in its delivery worktree, then call `team_artifact` before the provider turn ends. Both abbreviated and full commit hashes failed with `Revision … does not exist in the source repository`.

The host attempts the handoff check before the owner commit has been transferred to its repository. Automatic transfer after the owner turn ends works, but agents following the documented publish → review → finish sequence can block or retry instead of ending their turn.

Workaround used during this test: record one publication failure and finish the provider turn, allowing the automatic terminal transfer. This is a workaround, not a passing result for explicit publication. Experimental fixes remain outside the tested build.

### 2. The original objective can confuse a worker's role — unresolved

The original human objective told the lead to delegate and not implement the worker's files. That objective was repeated in the worker's context. The worker interpreted those lead instructions as its own and blocked because `canAssign` was false, despite a valid implementation assignment. The lead clarified the role automatically, costing an extra turn and delaying work.

### 3. A clarification message does not carry assignment status authority — recovery/UX gap

After the blocked assignment ended, the lead used a reply-requesting message to clarify implementation. The worker implemented the files during that message delivery but could not report status on the earlier task: `You can only report status for the task assigned to this active delivery`.

The task-authority check itself should remain strict. The workflow needs a clear way to continue the assigned task or tell the coordinator to create a new scoped assignment, rather than encourage execution in an unbound message turn.

### 4. Remote proxies appeared as shareable local agents — fixed before this frozen pass

After adding a remote agent, Add teammates displayed both its real teammate row and a local `(team proxy)` row with a sharing checkbox. `926365e` excludes proxy sessions from local publication and adds a browser regression. It also refreshes embedded team settings after publication; previously that view could remain at “No roster agents available” until reopened.

### 5. User-facing conversations expose verbose orchestration context — UX issue

The member's initial local-agent conversation displayed long group rules, the original request, assignment instructions and repeated context. The separate shared team session is available in the sidebar, but joining initially opens the local agent. This makes the requested group-chat experience harder to discover and scan.

## Observations and limits

- The first clone request took about 1.6 seconds; the invitation request took about 6.7 seconds. The first assignment was recorded about 8.6 seconds after the human request, and the owner run began about 4.4 seconds after assignment. These are observations, not latency guarantees.
- Pause holds scheduling; it did not stop already-running providers. Explicit interruption was used before the restart. This behavior should not be confused with stopping all paid work.
- Shared-browser tabs opened on the example workspace after the source desktop servers restarted on new ports. Persistence of the selected **native** workspace was not independently established; account persistence was.
- The first site passed title/heading checks, section-link checks, no overflow at 320/390/768/1440 pixels, mobile keyboard opening, Escape/focus restoration, link-driven menu closing, no hidden-nav focus, no page errors and no external requests. The lead's suspected hidden-navigation focus problem was not reproduced by that Chromium check.
- Screenshot automation in the shared preview failed twice with `Preview automation snapshot timed out after 15000ms`. Earlier initial-site screenshots used the cached Chromium workflow. The final requested test interactions use the shared browser; automation failures are not counted as Mingle product bugs.
- Live evidence uses real cloud delivery, email, Google authentication and provider execution, but two profiles on one physical computer. Different physical networks, Windows/macOS, real quota exhaustion and production pushes are not established. No code was pushed or deployed.

## Final shared-browser continuation

The explicit continuation was sent at 02:31:52 UTC. A new assignment was recorded at 02:32:00; the owner run started at 02:32:02. The worker committed `3dd4c1c` in its isolated worktree, attempted publication once, recorded the same publication error, marked its actual assigned task Review and ended its turn. Automatic terminal transfer integrated the revision into the host group worktree. The lead was woken for a separate result-review turn, inspected the real files and returned an Implemented summary. The request reached Completed with no running providers. The task remains Review pending human acceptance; that is expected.

Both accounts' shared browser tabs showed the original request, polish request, worker progress and coordinator summaries. The recipient must choose the separate Team session sidebar entry to view this conversation rather than its local agent's verbose native history.

The final page had no overflow in shared-browser frame viewports of 318, 388, 766 and 1278 CSS pixels. The menu opened, Escape closed it and restored toggle focus, selecting a section link closed it, every section link resolved, and no external dependencies were referenced. The frame's link activation left focus on BODY in this automation path, so the claimed destination-heading focus improvement is not established by this check. Shared-browser key/focus automation did not provide reliable independent keyboard navigation evidence; earlier initial-revision Chromium keyboard checks passed. This distinction prevents a source-code claim from being reported as a verified accessibility result.

Owner-control test: the recipient paused sharing through the shared browser. The leader observed `consent: paused` and state Paused. A directly addressed request remained queued and the owner provider run count stayed at four (zero active). Thus execution was blocked while paused. The host's queue hint said “Agent paused by you” even though the teammate owner performed the pause; that attribution is misleading. Sharing was then explicitly resumed to test queued delivery recovery.

### Additional UX findings

- The coordinator produced a Partially complete summary while waiting for transfer, followed by an Implemented summary after automatic result delivery. The provider can remain active polling while waiting for integration; clearer yield/wake guidance would reduce unnecessary turns and confusing intermediate final-looking answers.
- The project roster briefly reported the connected idle remote agent as Unknown while the team session knew it was idle. Availability freshness is inconsistent across those views; the root cause was not isolated during this test.
- A paused owner request is retained in the queue, rather than immediately rejected. This is distinct from executing while paused; the UI should make the resume behavior and who paused the agent clear.

After explicit owner Resume, the queued permission-check request executed exactly once: owner run count changed from four to five, with zero active runs after completion. The agent obeyed the no-edit/no-command request. The final host worktree remained clean at `3dd4c1c209724c457dfd4740a8196132b5077611`.

The known unresolved issues were recorded rather than fixed during this pass. Incomplete backend experiments remain isolated in the worker worktree and were neither committed nor integrated into `926365e`.

Final bidirectional chat check passed: the recipient sent a confirmation request through the shared session, the host lead replied with `3dd4c1c209724c457dfd4740a8196132b5077611` and `index.html, styles.css`, and the reply appeared in both shared-browser conversations. No tools, edits or new assignments were requested. At completion all provider runs and group deliveries were settled; sharing was restored and no code was pushed or deployed.
