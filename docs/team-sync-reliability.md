# Team synchronization and sharing repairs

This work addresses the sharing settings layout, invitation wizard overlays,
missing teammate rosters, repeated consent prompts, and delivery latency reported
after the 0.0.5 UI update. The installed 0.0.5 package does not contain these source
changes until rebuilt and installed.

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

## Verification boundary

`project-collaboration-two-app.acceptance.test.ts` exercises two real HTTP
applications, separate local databases and Git folders, actual PostgreSQL policies,
and encrypted/signed mailbox messages. Its optional Realtime fixture delivers only
empty wake hints, with a simulated 25 ms delay. The rename regression requires the
host's saved remote roster to update within one second without a manual sync.
The polling-only case retains lost-acknowledgement replay coverage.

These are local fixtures using example accounts and fake providers. They do not
measure the public Supabase service, a physical Windows recipient, provider
inference, or routes between continents. A local sub-second assertion is not a
guarantee for arbitrary internet connections.
