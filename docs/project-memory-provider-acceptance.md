# Memory, Full access and provider acceptance — 2026-11-02

Validated production source: `f5e9832` (later commits only clarify documentation). All automated provider runs use FakeProviders; no paid inference, account sign-in, live team mutation or host CLI upgrade was performed.

| Check | Result |
| --- | --- |
| Full server Vitest suite | 97 files passed; 710 tests passed, 1 skipped |
| Full web Vitest suite | 13 files passed; 51 tests passed |
| Server, web and contracts TypeScript checks | Passed |
| Vite production build | Passed |
| Memory browser acceptance | 10 checks passed |
| Provider update browser acceptance | 9 checks passed |
| Model picker browser acceptance | Passed, including custom IDs, parent-form isolation and narrow layouts |
| Project collaboration browser acceptance | 19 checks passed |
| Independent final reviews | No remaining concrete blocker in the reviewed provider updates, Full access publication or memory sharing fences |

The two-app acceptance uses the real encrypted mailbox implementation with disposable cloud fixtures and a credential-free local bare Git origin. It checks two worker deliveries, coordinator review and `team_accept`, the exact final origin revision, changed-file summaries, completed tasks, owner-signed replies and zero approval rows. It does not prove live Internet delivery or provider-specific account permissions.

Memory replication tests use real Ed25519 signatures over an in-memory relay. They cover reordered human controls and agent edits, checked ancestry, 65 writes before team binding, third-device backfill, compact metadata surviving SQLite reopening, stale evidence writes racing a pin, low-revision winning heads at the pruning limit, and account/device/binding changes while signing. Memory MCP/HTTP tests exercise run-token authority and human correction identities. Live encrypted cloud memory sync remains outside this evidence.

Update tests inject public manifests and child processes; the runtime lease test covers turns, compaction and interrupted-but-still-cleaning-up work. Public read-only endpoint checks for the three npm latest manifests separately returned HTTP 200, valid stable-version shapes and bodies below 4 KiB. No installed CLI was changed. The Windows native-root regression uses Node's Windows path rules; a physical Windows update was not performed. Antigravity remains checksum-pinned and managed by Mingle.

The browser scripts create disposable, explicitly labeled Example fixtures and do not send real invitations. Production build warnings from dependency annotation comments remain nonfatal.
