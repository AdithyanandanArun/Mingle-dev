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
- A slow initial roster request could overwrite a newer event-triggered response.
- Sender wall-clock timestamps could order a later pause behind an earlier grant
  if the owner's clock was corrected backwards.

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
settings edits. A permission increase beyond the owner's existing grant, a changed
disclaimer, or a newly selected agent still requires the relevant owner's consent.

Owner consent changes persist a strictly increasing timestamp before sending,
using the later of the current clock or the saved timestamp plus one millisecond.
Correcting a device clock backwards therefore cannot place a new pause or revoke
behind its earlier grant. The saved value survives restarts and keeps the wire
format compatible with existing clients.

The Teammates dialog uses one latest-request fence for initial, manual, and quiet
roster reads. A late response cannot replace a newer view or its form drafts.
Invitation setup has a separate operation fence, so a newer roster read does not
cancel the automatic sharing of the selected session.

## Verification boundary

`project-collaboration-two-app.acceptance.test.ts` exercises two real HTTP
applications, separate local databases and Git folders, actual PostgreSQL policies,
and encrypted/signed mailbox messages. Its optional Realtime fixture delivers only
empty wake hints, with a simulated 25 ms delay. The rename regression requires the
host's saved remote roster to update within one second without a manual sync.
The polling-only case retains lost-acknowledgement replay coverage.

The final integrated server suite passed 54 test files: 419 tests passed and one was
skipped. It includes the two-app project join and team-chat/task/artifact workflows.

The integrated web TypeScript check, six web unit tests, four consent-flow tests,
and Vite production build passed. Browser acceptance passed 19 project
collaboration checks and 24 Team workspace checks. These exercise exact-project
consent after a warm join, account changes, live roster invalidation, permission
preservation, and desktop/narrow layout geometry. The browser harness uses
explicit Example cloud/auth/email responses with a local FakeProviders runtime.
It does not send real invitations or run provider inference.

Acceptance logs for this run are `/tmp/mingle-team-sync-final-server-serial.log`,
`/tmp/mingle-team-sync-final-ui-verified.log`, and
`/tmp/mingle-integrated-team-workspace-acceptance.log`. Final UI captures are under
`/tmp/mingle-project-collaboration-acceptance-140961/`, including the full
`share-needed-card.png` and `join-consent-390px.png`.

An overlapping final test/build/browser run hit host memory pressure and was
stopped. Heavy checks were repeated separately. The browser regression harness
also needed to avoid waiting for a StrictMode-cancelled mount request and to select
the latest of multiple valid copy-link toasts; the verified log above is the
subsequent passing run.

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

## Live encrypted-envelope delivery

For an online recipient with a fresh local trust cache, `TransportService` persists
the sealed envelope to the sender's SQLite outbox, then starts the cloud mailbox
insert and a Supabase Realtime `httpSend` concurrently. The Realtime payload is the
same signed `SignedEnvelope` object used to form the mailbox row; its payload remains
end-to-end encrypted. A recipient accepts this fast path only when the envelope
route and expiry are valid, the sender is in the local device roster, both device
owners remain in the cached active-member roster, both devices are unrevoked, their
current public-key fingerprints match, and both cached pins are mutual. It verifies
the signature and decrypts locally, stores the inbox row with the mailbox path's ID
and idempotency uniqueness, then runs handlers under the same `handlerScope`. An
atomic inbox claim prevents a concurrent or late mailbox pull from running the same
envelope twice. Mailbox acknowledgement happens in the background. If it races the
insert or fails, subsequent pulls see the already
saved inbox row and safely retry acknowledgement.

The local trust cache has a 5-second refresh TTL. Senders with a complete valid
cached peer link do not wait for a roster refresh; an expired cache refreshes in the
background. A missing or invalid cached peer uses the existing refresh-before-send
path. Receivers with a stale cache, or without the sender in their roster, use the
normal authenticated mailbox sync instead of trusting the broadcast. That sync
refreshes roster and links before delivery. A revocation, unlink or membership change
can remain in a still-fresh live cache until its next refresh (at most five seconds);
the durable mailbox continues to enforce current cloud RLS.

Public Realtime broadcast topics are a SHA-256 derivation of a fixed protocol label
and the recipient's registered device fingerprint. Team members can read that
fingerprint from the team device roster; the topic is not derived from a device ID
or other data exposed outside the team. A public topic is not an access-control
boundary: anyone who learns it can subscribe and observe broadcast timing, envelope
size, and the envelope's clear routing/header metadata (including device IDs, kind,
timestamps and idempotency key). They cannot decrypt the payload, create an accepted
message without the pinned device signing key, modify an envelope without breaking
its signature, or make a replayed/expired envelope run a handler again. Forged
broadcasts are rejected locally; an unknown sender can prompt the ordinary mailbox
catch-up (which retains the existing 10,000-row per-sync scan cap). This design uses
existing public Realtime broadcast and does not require or apply a migration to the
hosted Supabase project.

The serialized-envelope broadcast limit is 64 KiB, conservatively below the normal
distributed payload limit. Larger envelopes skip the payload broadcast and retain
the mailbox plus empty wake behavior. Failed Realtime sends also trigger the empty
wake; if Realtime is absent, mailbox polling remains the recovery path. An online
device with a successful fast path persists locally before acknowledging cloud
storage, preserving durability across a mailbox/publish race.

`scripts/measure-team-latency.mjs --from-url URL --from-project ID --to-url URL
--to-project ID` sends ten unique team-chat probes and reports p50/p90 time until
each appears in the destination transcript. Its output contains aggregate timings
only, not the probe text or server response bodies. The transport acceptance test
uses a deterministic 90 ms per-request fake-cloud delay; it verifies that handler
delivery stays near two simulated network turns rather than the prior sequence of
roster, mailbox, and per-row authorization reads. This local measurement is not a
public-network performance guarantee.
