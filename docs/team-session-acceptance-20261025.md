# Team session recovery acceptance — 2026-10-25

The reported flow is invitation → local checkout/provider selection → explicit owner consent → Add agents in an ordinary session → the same group conversation on both devices. Team mode alone no longer creates a separate group. Publishing an agent does not change its saved permission policy or start inference.

## Reproduced failures and corrections

- An inbound mailbox handler could await the transport sync that was waiting for that handler. Handler-scoped sync requests now request another pass instead of waiting on themselves.
- Host deliveries used a fixed 90-second total runtime limit. Owner heartbeats now extend a persisted idle deadline, including during approval waits; the host also applies a configurable absolute cap. Timeout wording uses actual device presence.
- Completed agent replies could remain in `sending` after interruption. Bounded, fair recovery retries only saved completed output, preserving message/signature identity and rechecking account, device, membership and published-agent authority. It does not reroute saved human input or restart provider work.
- Valid redundant history requests could repeatedly fail the durable inbox. They are now consumed within the existing cooldown.
- The test team remained Supervised despite both agents and the owner consent allowing Full access. The live test team was explicitly updated to Full access; both instances observed settings version 4 without invalidating the already sufficient consent.

## Automated evidence

- Integrated host, owner-device, group-handover, transport and chat checks: 75 tests passed.
- Chat recovery after the fair-cursor review fix: 14 tests passed; server TypeScript passed.
- Encrypted two-app team-chat acceptance passed after the integrated liveness and handler-deadlock changes. This covers local HTTP applications, separate SQLite/device keys, production encryption and a PostgreSQL policy fixture, rather than live cloud delivery.
- Join/consent flow helper checks: seven passed.
- Web TypeScript and Vite production build passed. Existing dependency annotation warnings remain.

No paid inference runs in these automated checks. Live provider execution and live cloud observations must be recorded separately below after verification. These checks do not establish behavior across physical computers or networks.

## Follow-up checks — 2026-10-26

The pre-fix full server baseline passed 357 of 358 tests. The sole failure was a stale hard-coded schema-version expectation; the corrected migration test checks that old databases acquire `terminal_status_json` and reach the current schema version. All 32 resilience tests passed after that correction. This baseline predates the final artifact and host fixes and is not the final combined-suite result.

Artifact checks now inspect every included commit, including intermediate changes and deletions, on both send and import. Committed protected paths reject the artifact; assigned scopes also constrain snapshots and reject committed changes outside the assignment. The focused device/Git checks passed 31 tests. Application wiring places retained delivery worktrees under the configured runtime-data directory; retention and explicit cleanup are documented in `team-artifact-retention.md`.

The desktop Node tests passed 41/41; web unit tests passed 5/5, and the web typecheck passed. The static invitation landing-page browser check passed with an example token, including mobile geometry, fragment cleanup, and absence of token-bearing server requests. These checks sent no live email and ran no provider inference.

The old project-collaboration browser script failed against the new multi-step join screens and incomplete example fixtures. That harness is being updated against the actual UI; this failure is not recorded as successful onboarding evidence.

The combined server suite at `47ab580` passed 365 tests and failed the two-app acceptance test while waiting for the second remote worker run (366 total). Server typecheck passed. The failure is under investigation; the live coffee-shop test remains pending. The refreshed project-collaboration browser harness passed 8/8 checks using Example cloud fixtures and no paid inference.

Final scoped review identified a shutdown path that overwrites the durable completion intent while artifact integration is pending; it has been returned for correction. A second review claim about `git rev-list --reverse --max-count=30` omitting HEAD was checked and contradicted by Git: the bounded revision list ends at HEAD because the count limit is applied before reversal. The artifact worker is verifying the end-to-end boundary before any change is made for that claim.

The artifact worker independently disproved the commit-limit claim with a 31-commit GitSync export/import/integration: receiver HEAD matched source HEAD and all 31 changed files arrived. No source change was made for that claim.

The two-app acceptance test passed after `f1769f9` released the finished proxy execution slot before the repository mutation lease. The passing fixture includes an active worker question, a completion-style review message sent before the worker turn ends, automatic artifact integration, and a second scoped assignment based on the integrated revision. This uses FakeProviders and a PostgreSQL policy fixture, not live cloud or inference. Shutdown preservation remains under correction before the final combined rerun and live test.

The final combined suite at `f568fc2` passed all 367 tests across 50 files (98.26 seconds), including encrypted two-app delegation and graceful shutdown/restart preservation. Server typecheck passed. Automated checks are complete; the fresh live two-account coffee-shop workflow starts after this result.

## First live run — 2026-10-26

Using two isolated native Electron profiles on one physical Linux host, the leader authenticated as the configured sender account, cloned the existing public repository into a fresh project, and sent an actual invitation through Add teammates. The recipient received the email in Gmail, opened the HTTPS landing page, and reached the native desktop join dialog through the real OS protocol handler. The token disappeared from the local app URL. Recipient Google sign-in resumed the pending invitation; the clone wizard created the selected fresh folder, and the recipient configured an idle Codex Luna agent with Full access and explicitly granted Full access team consent. Both apps observed settings version 2 and granted consent. The original OS handler was restored immediately after the link test.

Clone request duration was about 1.6 seconds; the invitation request took about 6.7 seconds. The human group request was accepted within milliseconds, the lead created its first assignment about 8.6 seconds later, and the owner runtime started about 4.4 seconds after that assignment. These are observed timings, not a latency guarantee.

The initial worker misread the original objective's instructions to the lead as its own delegation instructions. The lead clarified this automatically. The worker then built and committed both website files. Explicit remote `team_artifact` calls failed because the host attempted to validate the owner-side commit before transfer. A later automatic terminal transfer did import the commit into the host group worktree; the lead reviewed those actual files. This does not establish a complete two-pass workflow: the requested polish assignment remained unfinished. The group was intentionally paused and both active provider runs interrupted to stop repeated attempts. Subsequent MCP 401 responses resulted from that intentional authority revocation.

The generated initial site at commit `47d9ac739f118dd2ea9249d29ad11794bb9f9981` passed 14 local Chromium browser checks: title/heading structure, valid section links, no overflow at 320/390/768/1440 pixels, mobile keyboard opening, Escape closure and focus restoration, closing after a navigation link, focus outside the hidden navigation, no uncaught errors, and no external resource requests. Desktop and mobile screenshots were retained outside the source tree. This is visual/browser evidence for the initial site, not proof that the second handoff completed.

The shared preview's click/screenshot automation timed out; DOM interaction in that same browser remained available. The native link was dispatched through `xdg-open`, and native Electron CDP confirmed the join prompt. After two screenshot timeouts, the cached Chromium workflow supplied the site screenshots and keyboard checks. Browser external-protocol confirmation itself was not established by the preview click automation. This run used real cloud/email/provider services but two profiles on one physical computer, not separate physical networks.

The live roster also exposed a duplicate remote proxy shown as a local shareable agent. `926365e` hides proxy sessions from the local publication list and refreshes the embedded team settings after publishing. The updated eight browser acceptance checks and web typecheck passed. The first live run's processes were closed normally after interruption; credentials remain in native secure storage for the restart check, and the OS protocol handler is restored to `mingle.desktop`.

## Completed test run with recorded defects

At the user's request, implementation was frozen at `926365e` and the remaining test interactions ran in the shared browser. The second remote assignment completed, automatic transfer integrated website revision `3dd4c1c209724c457dfd4740a8196132b5077611`, and the lead reviewed actual returned files and finished its result turn. Owner pause prevented execution; explicit Resume released exactly one queued request. Both identities survived native restart. The site worktree is clean. This is completion of the test, not a clean product pass: the explicit artifact API still fails, and a manual continuation/workaround was required. See `coffee-shop-full-test-20261026.md` for the consolidated results, bugs and limits. No incomplete worker backend changes were integrated during this final test pass.
