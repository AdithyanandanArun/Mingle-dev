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
