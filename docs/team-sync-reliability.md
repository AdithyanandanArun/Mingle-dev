# Team synchronization and sharing repairs

This work addresses the sharing settings layout, invitation wizard overlays,
missing teammate rosters, repeated consent prompts, and delivery latency reported
after the 0.0.5 UI update. The installed 0.0.5 package does not contain these source
changes until rebuilt and installed.

## Reproduced causes

- Sharing settings used a two-column outer grid. Full-width status notices
  changed auto-placement and pushed permissions into a later right-hand cell.
- Consent rows styled every direct `span` as flexible text, stretching the
  provider mark into the reported grey bar.
- An open Teammates dialog did not subscribe to incoming roster invalidations.
  A host could have the agent in SQLite while the visible list stayed unchanged.
  A two-app regression reproduced the missing project-scoped invalidation before
  a canonical group was configured.
- Publishing before a peer became mutually linked did not schedule that peer to
  receive the saved roster later.
- Consent arriving ahead of its owner's roster was rejected rather than retained
  until the roster could prove the selected agent identities.
- Editing consent initialized the maximum permission to Supervised, including
  when the owner already had a valid Full access grant.
- The join overlay's consent sheet read the active workspace's team context,
  which could belong to a different project. It could submit a guessed settings
  version of 1 while the newly joined project's actual settings were unavailable.
- A Realtime channel error permanently disabled that device's fast wake path.
  Joining a channel also lacked a catch-up read for hints missed during setup.
- Mailbox partitions were processed sequentially, and handler dispatch waited
  behind unrelated team work and outbound retries.
- Roster snapshots synchronously queried ancillary email-sender readiness.

## Local metadata propagation

The distributed workspace listens for durable session configuration, run, task,
group membership and approval changes. It coalesces these for at most 40 ms before
refreshing agents and tasks that the owner already published. Streaming text,
generic store touches and incoming structure events do not trigger this work.
Changes arriving during an active refresh schedule a follow-up refresh.

Device and mutual-link topology changes also trigger catch-up. Heartbeat
timestamps and ordinary outbox updates do not. Saved outgoing roster versions
remain eligible for catch-up even when their current agent list is empty, so
withdrawals can reach a newly linked peer. The 30-second timer remains a recovery
and presence-refresh fallback; it is no longer the only way to publish edits.

Browser team updates coalesce in a bounded 80 ms window. Continuous activity no
longer postpones the UI refresh indefinitely by resetting a trailing debounce.

## Roster and consent recovery

Each published roster version is tracked per recipient device until acknowledged.
An unchanged roster can therefore reach a newly linked peer, and an empty roster
can withdraw agents after a reconnect. Receivers acknowledge only the version
they applied; older publications cannot restore agents after a newer withdrawal.

The host retains authenticated consent that arrives before its selected agents.
It applies the grant only after the owner/device roster proves those identities.
Queued consent is bounded and expires; an older grant cannot replace a newer
pause or revocation. An existing Full access grant remains valid through unrelated
settings edits, while a permission increase, changed disclaimer, or newly selected
agent still requires the relevant owner's consent.

## Verification boundary

`project-collaboration-two-app.acceptance.test.ts` exercises two real HTTP
applications, separate local databases and Git folders, actual PostgreSQL policies,
and encrypted/signed mailbox messages. Its optional Realtime fixture delivers only
empty wake hints, with a simulated 25 ms delay. The rename regression requires the
host's saved remote roster to update within one second without a manual sync.
The polling-only case retains lost-acknowledgement replay coverage.

The integrated server suite passed 54 test files: 417 tests passed and one was
skipped. It includes the two-app project join and team-chat/task/artifact workflows.

The integrated web TypeScript check, six web unit tests, four consent-flow tests,
and Vite production build passed. Browser acceptance passed 19 project
collaboration checks and 24 Team workspace checks. These exercise exact-project
consent after a warm join, account changes, live roster invalidation, permission
preservation, and desktop/narrow layout geometry. The browser harness uses
explicit Example cloud/auth/email responses with a local FakeProviders runtime.
It does not send real invitations or run provider inference.

Acceptance logs for this run are `/tmp/mingle-team-sync-full-server.log`,
`/tmp/mingle-integrated-ui-acceptance.log`, and
`/tmp/mingle-integrated-team-workspace-acceptance.log`. Final UI captures are under
`/tmp/mingle-project-collaboration-acceptance-122093/`, including the full
`share-needed-card.png` and `join-consent-390px.png`.

The transport's RTT regression also delays each authentication bridge and
PostgREST request by 90 ms. One measured sample after parallelizing independent
authority reads was 655 ms from wake publication to handler and 931 ms from send
start to handler. These measure raw transport delivery; application-level roster
validation and rendering add their own work. A second regression blocks another
team's heartbeat, waits until the ready team's empty inbox has already been read,
then sends to the ready team and requires delivery before releasing the block.

These are local fixtures using example accounts and fake providers. They do not
measure the public Supabase service, a physical Windows recipient, provider
inference, or routes between continents. A local sub-second assertion is not a
guarantee for arbitrary internet connections.
