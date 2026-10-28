# Distributed device transport API

`TransportService` is the local, outbound-only encrypted mailbox adapter used by distributed Mingle services. It does not open an inbound port, expose the local HTTP server, run provider work, or interpret received payloads. The caller remains responsible for authorization and operation-specific validation before acting on an authenticated message.

## Construction and lifecycle

```ts
new TransportService({
  account,                 // AccountService-compatible bridge
  store,                   // { db: Store.db } using node:sqlite DatabaseSync
  dataDir,                 // private Mingle runtime data directory
  changed?,                // optional local state notification
  now?,                    // injectable millisecond clock
  retryBaseMs?,            // default 1,000 ms
  onlineWindowMs?,         // default 90,000 ms
  messageTtlMs?,           // default 7 days
  syncIntervalMs?,         // default 20,000 ms for start()
});
```

The account bridge contract is `withAuthenticatedClient(callback: (client: SupabaseClient, user: User) => Promise<T>)`. The account service must verify the current Google account with Supabase `auth.getUser()` for each callback; transport does not accept a renderer-supplied account ID or use a service-role client. Calls requiring cloud authority stay inside that callback. Incoming handlers are invoked only after the account callback is released, avoiding nested account-operation deadlocks.

- `start(): void` launches the periodic sync loop and immediately requests an initial sync. It does not create a listener or server socket.
- `snapshot(teamId?): TransportSnapshot` returns `{deviceId, devices, links, outbox, status, error}` for the signed-in account. `status` is `ready`, `offline`, `signed-out`, `unregistered` or `error`; a device's `status` is `online`, `offline` or `revoked`; outbox `status` is `queued`, `delivered` or `expired`. With no team filter, `deviceId` is the first registered local device in team-ID order; device lists and the 100 most recent outbox items contain no payloads. A signed-out snapshot contains empty device/link/outbox lists and a null device ID.
- `register({teamId, name}): Promise<DistributedDevice>` creates this runtime's identity in the team, or refreshes its heartbeat. Device keys, ID and name are immutable after registration. Re-registering a revoked identity creates a fresh local device ID.
- `link({teamId, deviceId, fingerprint}): Promise<DistributedDeviceLink>` pins the peer's exact `SHA-256:<lowercase hex>` fingerprint. Linking is unilateral; sending and receiving require the reciprocal pin too. An explicit link call replaces a stale own-side pin using delete+insert, consistent with the cloud table's insert/delete-only grants.
- `revoke({teamId, deviceId}): Promise<void>` revokes a device owned by the active account, or removes this device's pin to a peer. Cloud row-level security remains authoritative for member/device revocation; every pending inbox dispatch refreshes current membership, device state and trust links before invoking a handler.
- `send({teamId, toDeviceId, kind, payload, idempotencyKey}): Promise<string>` validates, encrypts and durably inserts the envelope in the local outbox before attempting the cloud write. A repeated key with the same local payload returns the original envelope ID; using it for a different payload rejects with HTTP 409.
- `onMessage(handler): () => void` subscribes to authenticated `{id, teamId, fromDeviceId, toDeviceId, kind, payload}` messages. Register one routing handler for the transport and route each `kind` to services that independently validate their authority. Handlers are async-capable; a known handler failure remains durable and is retried with bounded exponential backoff.
- `invalidateTeamTrust(teamId): void` marks the current device's team-trust snapshot stale and starts an authenticated roster/device/link refresh. The next live envelope is deferred until freshness is restored; mailbox polling remains the recovery path if refresh fails. Roster/structure/device-change deliveries and local device/link revocation invoke this automatically.
- `sync(): Promise<void>` refreshes authenticated device/trust state, flushes due outbox entries, receives and acknowledges relay rows after local persistence, and dispatches pending inbox work. Concurrent calls coalesce.
- `close(): Promise<void>` stops the timer, waits for in-flight sync and handler work, removes owned send/receive Realtime channels and clears in-memory key objects and handlers. Local key and mailbox records remain available for restart.

## Data and wire protocol

Contracts live in `packages/contracts/src/devices.ts`. Message kinds include the `execution.*`, `collaboration.*`, `git.*`, `command.*` and `teamchat.*` namespaces. Team/device identifiers are UUIDs; idempotency keys are 1–200 ASCII letters, digits, dots, underscores, colons or hyphens. Canonical JSON payloads are limited to 256 KiB.

Each runtime has Ed25519 signing and X25519 encryption keypairs. Private PKCS#8 material is stored in a per-account JSON file below `<dataDir>/distributed/keys/`, with a hashed account filename, mode `0600` (directory mode `0700` where supported), and never in SQLite or tracked source. Public SPKI DER keys are registered at `mingle_devices`. The fingerprint hashes both public keys under a versioned domain separator. Device pairing compares that fingerprint out-of-band before recording an own-side pin.

The transport derives a per-envelope AES-256-GCM key from static X25519 agreement using HKDF-SHA256, team ID as salt and sender/recipient/envelope IDs as context. The routing header is GCM associated data; the complete routing header, nonce and ciphertext are Ed25519-signed. Plaintext is canonical JSON and is cleared after encryption/decryption. A received envelope is not surfaced until its Ed25519 signature, AEAD tag, route, size, expiry, device fingerprints and mutual pins pass validation.

The authenticated Supabase client accesses only the blueprint tables `mingle_devices`, `mingle_device_links` and `mingle_envelopes`. Device refreshes update only `last_seen_at`; revocation updates only `revoked_at`. A link re-pair is delete+insert. Outbound envelopes use `upsert(..., {onConflict: 'team_id,from_device_id,to_device_id,idempotency_key', ignoreDuplicates: true})` without `.select()`: sender-side RLS intentionally does not permit reading mailbox rows, and no UPDATE grant is required. The cloud `mingle_envelopes.received_at` column must be server-stamped while preserving the signed instant in `created_at`; the receiver uses server `received_at`, never peer-controlled `created_at`, for delivery order.

PostgREST serializes `timestamptz` values with UTC offsets and variable fractional precision. Before signature verification, `created_at` and `expires_at` are validated as RFC3339 instants and normalized through `Date.toISOString()` to UTC milliseconds, matching the sender's canonical JS timestamp. Invalid timestamps are rejected. `received_at` is normalized to a fixed-precision UTC sortable value while preserving PostgreSQL's microseconds for local inbox ordering.

## Durability, retry and delivery meaning

SQLite tables are namespaced `mingle_transport_*` and include account IDs in local device, cache, inbox and outbox keys. The outbox stores only ciphertext and public routing metadata. Envelopes expire after seven days. Cloud insert failures retain the row with an exponentially delayed retry (capped at one hour); status and error remain visible in the snapshot.

Inbox scans read at most 100 rows per page and 10,000 per sync, ordered by server `received_at` then ID. For each page, the service first commits every valid envelope to the account-scoped SQLite inbox (uniqueness prevents duplicate rows), then deletes those relay rows through the recipient's RLS-authorized delete policy. A failed local save leaves the cloud row untouched; failed cloud acknowledgement leaves the durable local row and safely repeats the idempotent insert on the next sync. The next page starts at the oldest remaining relay row, so large mailboxes continue progressing across syncs without repeatedly scanning an old offset range. Invalid/tampered relay rows are discarded and acknowledged so they cannot block later rows.

Before dispatching each local inbox item, transport re-enters the verified account callback, heartbeats the recipient device, reloads the current team device roster and trust links through RLS, and verifies both current fingerprint pins. Membership loss, revocation, expired messages and revoked trust reject pending delivery. The handler runs only after these checks and after the cloud callback has returned.

The service durably claims an inbox row before invoking its handler. Successful handlers become `handled`; known failures return to `pending` with a bounded retry delay and recorded error. If the process stops while a handler is in progress, startup marks its `dispatching` row `uncertain` and never invokes it again automatically. This avoids replaying a potentially dispatched operation after a crash; the owning execution/recovery service must resolve an uncertain outcome explicitly. Operation handlers should also be idempotent by envelope ID.

An outbox status of `delivered` means the cloud relay accepted the idempotent envelope (or an identical retry found the same uniqueness slot). It does **not** mean the recipient handler ran, an agent executed, or a result was acknowledged. The cloud has no sender-visible read policy and the current transport has no recipient-to-sender acknowledgement protocol. User-facing state must therefore distinguish relay acceptance from remote execution or completion.

## Integration requirements and limitations

The orchestrator owns HTTP route and `packages/contracts/src/index.ts` wiring. It must export `./devices` from that barrel and construct the service with the existing `Store.db`, private `dataDir` and verified account bridge. The distributed teams migration must include the server-generated `mingle_envelopes.received_at`, preserve the signed `created_at` instant rather than replacing it, and grant recipient-owned envelope deletion under RLS. The service intentionally has no inbound API or production cloud deployment.

Online/offline device status is derived only from the server heartbeat time and a bounded freshness window; failed syncs remain offline/error rather than manufacturing presence. Link/member/device revocation blocks future sends through cloud RLS and blocks local pending dispatch after a fresh authority check. Credentials stay with their providers and are not transported.
