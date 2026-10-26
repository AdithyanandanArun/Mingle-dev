# Current-session sharing acceptance

The 0.0.4 setup uses the conversation captured when Teammates opens. Sending an invitation fetches the newly created collaboration binding and attaches that conversation if the project has no canonical shared group. Later invitations retain the established shared group. Permission changes remain versioned and preserve owner consent boundaries.

## Integration evidence

- The HTTP acceptance test uses a real local application, SQLite, Git worktrees, GroupService and the existing disposable PostgreSQL policy fixture. It shares an unpublished local session, verifies its agent is the lead, retries without creating another group, changes permission, rejects replacement by another private conversation, and adopts an existing group whose lead differs from its visible anchor. Existing messages remain and FakeProviders records zero runs.
- Web and server TypeScript checks, the production web build and all five web unit tests passed.
- The project-collaboration browser harness passed all 18 cases including unsupported-provider preflight, canonical permission editing, fixture state isolation and explicitly injected failure responses. The cloud/auth/email/clone/join boundary remains labeled Example data.
- Shared T3 browser verification used the built UI against a disposable local application with real HTTP, SQLite, Git and the PostgreSQL policy fixture. Starting with two local sessions and no shared binding, inviting from **Coffee shop planning** shared that exact session and its agent. **Older private session** remained unshared. There were still two local sessions, one shared group and zero provider runs. Full access saved successfully, and reopening the conversation retained its existing text and group composer. The setup contained zero selects and zero leader switches.

Shared-browser screenshot: `/home/adithyan/.t3/userdata/browser-artifacts/browser-screenshot-127-0-0-1-mvplc5ub-91340107.png`. The disposable workspace was stopped and removed afterward.

The browser verification used an injected authenticated identity and a local PostgreSQL fixture. It sent no real invitation email, accepted no live invitation and invoked no paid provider. Native Windows/Linux packaging checks are recorded by the release workflows.

The two-device handoff case initially exhausted a single 15-second budget shared by two sequential assignments. Diagnostics showed the last result durably delivered, with no authorization or tool error. The complete case passed with a diagnostic 30-second combined budget (41.08 seconds for the entire test), then passed with a separate bounded 15-second deadline for each dependent worker phase (41.07 seconds overall). The final test retains artifact, review, authorization and exactly-once reply assertions and records reply/mailbox timing diagnostics on failure. Production transport, polling and provider timeouts were unchanged.

## Final release checks

Source `4a18836` passed [GitHub validation](https://github.com/AdithyanandanArun/Mingle-dev/actions/runs/40380615334): **407 backend tests passed, one Windows-only test skipped** across 54 files. Local web tests passed 5/5, and browser acceptance passed 18/18. The final provider preflight regression covers an unsupported lead and an unsupported worker even when the anchor is already published; both reject before publishing, binding or changing the group.

The [Linux build](https://github.com/AdithyanandanArun/Mingle-dev/actions/runs/40380654027) and [Windows build](https://github.com/AdithyanandanArun/Mingle-dev/actions/runs/40380651392) passed native runtime, installed-app and installer lifecycle checks. All release assets are built from that exact source commit. Final read-only Luna review found no blocking issue in the full-group preflight correction.

The stable [0.0.4 release](https://github.com/AdithyanandanArun/Mingle-dev/releases/tag/v0.0.4) was published by [run 40381462964](https://github.com/AdithyanandanArun/Mingle-dev/actions/runs/40381462964). The publisher verified all six asset names, sizes and SHA-256 digests before making the release public.

| Asset | SHA-256 |
| --- | --- |
| Linux archive | `a383d3185694b3a7d00fae70ea6547b9e9c357ba221754d1b1fbcf87adfd35f6` |
| Windows installer | `040a6594da7769b170f774118a1755a114e8f6ada7dfad3901afd47eca46c844` |
| Debian package | `9ad7ef258cf333e627a8b55fdbd626caf82ff082cc59ef42cfcdd47c3ad3bc7d` |
