# Autonomous project memory

Agents remember, update, recall and retire project knowledge (decisions, conventions, gotchas, facts, verification results) on their own, without a human approving each entry and without any background model running. People can read, search, edit, pin and retire the same entries. Teammates' devices share it over the existing authenticated, encrypted device transport.

Memory is **data, never instructions or permission authority**. It is injected into a run as a labelled, JSON-encoded reference block, it cannot change a run's policy or approvals, and an entry that tells an agent to ignore its instructions is just text in a field.

Contract: `packages/contracts/src/project-memory.ts` (Zod schemas + types, exported from `@mingle/contracts`). Server: `apps/server/src/project-memory/`.

## Data model

| Field | Meaning |
|---|---|
| `kind` | `decision` \| `convention` \| `gotcha` \| `fact` \| `verification` |
| `status` | `tentative` or `evidenced`. **Only the server assigns `evidenced`**, and it means *references were checked*, not that the text is true (see Evidence). An agent asking for `evidenced` without a checkable reference gets `tentative` plus a notice. An agent edit that changes the text without re-supplying evidence also resets the entry to `tentative`. |
| `lifecycle` | `active`, `stale` (a referenced file's content no longer matches what was recorded, *on this device*), or `retired` (tombstone). |
| `pinned` | A person pinned it. Pinned entries are always offered to runs first (max 3) and **agents cannot edit or retire them**. |
| `humanVerified` | A person created, edited or re-verified it. Any later agent edit clears it. |
| `revision` | Integer starting at 1; increases by one on every durable change (content, pin, retire, restore). Stale marking does **not** change it (it is per-device state). |
| `author` / `updatedBy` | `{kind:'agent', sessionId, runId, name, provider, model, accountId, deviceId}` or `{kind:'human', displayName, accountId, deviceId}`. Always taken from the authenticated run or the signed-in account — never from tool arguments or request bodies. |
| `files[]` | `{path, revision, baseRevision, verifiedAt}`; `path` is project-relative, `revision` is a SHA-256 prefix computed by the server. |
| `sources[]` | Server-verified non-file provenance: `commit` (exists in the project repo), `command` (a completed tool call in the authoring run that exited 0), and `run` (the authoring run, added automatically as provenance). Unverifiable references are dropped with a notice. |
| `stale` | `null`, or `{since, reason, paths}` explaining which files changed. |
| `origin` | `{local:true}` if last written on this device, else `{local:false, deviceId}` of the teammate device that sent it. |
| `match` | Only on search results: `{score, fields}`. |

### Evidence rules

- A file reference is checked by the server reading the file inside the run's worktree (symlinks resolved, must stay inside it) and hashing it. A commit reference is checked with `git cat-file` in the project repository. A command reference is kept only if the same run recorded a *completed* command tool call containing it with exit code 0.
- `evidenced` requires at least one checked file, commit or command. The automatic `run` provenance reference **never** counts on its own.
- A `verification` entry needs a checked **command** (a completed, successful result in the authoring run); files or commits alone leave it `tentative`.
- People's entries get the same treatment (their file references are checked too); `humanVerified` is the separate signal that a person vouched for the text. Pinning alone does not set it.
- Changing an entry's text as an agent without supplying evidence again resets it to `tentative`.

### Safety filters (applied to agent and human writes, and re-applied to every received team record)

- Writes containing secret-looking material (private keys, bearer/API tokens, `password=` assignments, long high-entropy strings, cloud key prefixes) are **rejected**, not redacted.
- File paths must be project-relative, without `..`, absolute roots, NULs or backslash tricks, must not be inside `.git/` and must not look like credentials (`.env*`, `*.pem`, `id_rsa*`, `.ssh/`, `.aws/`, …). Rejected paths are dropped with a notice; the entry is still stored if the rest is valid.

### Bounds

500 live entries per project, 2,000 retired tombstones, 50 revisions per entry (first revision kept), 8 files, 120-char titles, 1,500-char bodies, ≤25 agent writes per run, ≤10 search results, run context ≤8 entries / ≤4,000 chars. Duplicates are merged: writing an entry with the same normalized body, the same kind and normalized title, or near-identical title *and* body wording as a live one updates it (`outcome: 'merged'` / `'unchanged'`) instead of adding a second. Normalization is Unicode-aware (NFKC, letters and numbers of every script; text with no letters or digits is compared exactly together with its body), and search tokenizes unspaced scripts (Chinese, Japanese, Korean, Thai…) into character pairs, so non-Latin entries are never collapsed into each other and are searchable. An agent cannot recreate an entry a person retired.

## HTTP API (local, loopback, same security guard as the rest of `/api`)

All paths are under the local project id. Errors use the existing shape `{ "error": string }`: `400` validation (including secret/path rejections for a human write), `404` unknown project/entry, `409` conflicts (`Memory entry changed; current revision is N` for a stale `expectedRevision`, or memory full).

### `GET /api/projects/:projectId/memory`

Query (`ProjectMemoryQuerySchema`): `q?` (search text; when present results are ranked and carry `match`), `kind?`, `status?`, `pinned?=true|false`, `include=live|retired|all` (default `live` = active + stale), `limit` (1–100, default 50), `cursor?` (opaque, from `nextCursor`).

Without `q` the order is pinned first, then most recently updated. Response `ProjectMemoryListResponse`:

```jsonc
{
  "entries": [ProjectMemoryEntry],
  "total": 12,                      // matches before paging
  "nextCursor": null,
  "counts": { "live": 12, "stale": 1, "retired": 3, "pinned": 2, "tentative": 7, "evidenced": 5 },
  "sharing": {                      // how/whether this project's memory is replicating
    "shared": true, "teamId": "…", "sharedProjectId": "…", "localDeviceId": "…",
    "peerCount": 1, "unpublished": 0,
    "lastBackfillAt": "…", "lastReceivedAt": "…", "error": null
  },
  "limits": { "maxLiveEntries": 500, "maxRevisionsPerEntry": 50 }
}
```

Reading refreshes stale marks for the project first (rate-limited; see Staleness).

### `GET /api/projects/:projectId/memory/:entryId`

`ProjectMemoryEntryDetail` — `{ entry, history, historyTruncated }`; `history` is the newest ≤20 `ProjectMemoryRevision`s. Works for retired entries.

### `GET /api/projects/:projectId/memory/:entryId/history?limit=50&cursor=`

`ProjectMemoryHistoryResponse` — `{ entryId, revisions, nextCursor }`, newest first. Each revision has `op` (`create|update|pin|retire|restore`), `author`, `at`, `note`, a full `snapshot`, the `changed` field names, `received` (came from a teammate) and `superseded` (a concurrent write to the same revision number from another device that did not become the head).

### `POST /api/projects/:projectId/memory`

Human create. Body `CreateProjectMemorySchema`: `{ kind, title, body, files?, pinned? }`. Returns `ProjectMemoryWriteResult` `{ entry, outcome, notices }` with status `201` for `created`, `200` for `merged`/`unchanged`. `notices` lists ignored paths etc. — show them.

### `PATCH /api/projects/:projectId/memory/:entryId`

Body `PatchProjectMemorySchema`:

```jsonc
{
  "expectedRevision": 3,            // required; mismatch → 409, refetch and retry
  "expectedHeadId": "…",            // required stable record id from the same entry snapshot
  "title": "…", "body": "…", "kind": "gotcha",
  "files": ["src/a.ts"],            // replaces file refs; the server re-hashes. [] clears.
  "pinned": true,                   // pin / unpin
  "lifecycle": "retired",           // retire (tombstone) — or "active" to restore a retired entry
  "note": "why"                     // optional, ≤300 chars, stored on the revision
}
```

At least one change besides `expectedRevision`/`expectedHeadId`/`note` is required. `expectedHeadId` is `entry.headRecordId` captured with `expectedRevision`; both must still match the current head. This identity check also catches a stale edit when conflict resolution rolls the numeric revision back to a number the client previously saw. Returns `ProjectMemoryWriteResult` with the new revision and head id. Humans are never locked out by `pinned`. Sending `lifecycle:"active"` on a **stale** entry re-hashes its files against the current project files and marks the entry `humanVerified` (this is the "still true" action); if a referenced file no longer exists the entry stays stale and a notice says so. `humanVerified` becomes true on any human content edit.

### `GET /api/projects/:projectId/memory/context-preview?query=`

`ProjectMemoryContextPreview` — what a run started now with that prompt would receive: `{ injection: {at, query, entries[{id,revision,title,kind,lifecycle,pinned,reason}], chars, truncated}, text }`. `text` is the exact block injected. Read-only.

### `GET /api/sessions/:sessionId/memory-injections?limit=20`

`ProjectMemoryInjectionsResponse` — the most recent memory blocks given to that session's runs (`runId`, `at`, entries with the revision that was shown and why: `pinned|relevant|recent|stale`). 404 for unknown sessions. Retained for the newest 200 injections per project.

### `POST /api/projects/:projectId/memory/sync`

Asks linked teammate devices to resend memory this device is missing (it also happens automatically when the project's memory is opened, rate-limited, and when team topology changes — there is no periodic poll). Body `{}`. Returns `202 { "requested": <peer count> }`; `409` when the project is not team-shared or this device is not registered.

### Workspace events

Delivered on the existing `/ws` `state.changed` events (`WorkspaceEvent`, `projectId` set): `memory.updated` `{entryId, revision, op, origin:'local'|'peer'}`, `memory.stale` `{entryIds}`, `memory.injected` `{sessionId, runId, count}`. Refetch the list/detail on these.

## Agent tools (`mingle_memory` MCP server, run-scoped)

Same pattern as `mingle_progress`: a per-run bearer token on `/api/memory/mcp`, revoked when the run ends, absent from read-only plan runs. Supported on all four providers (Claude `mcp__mingle_memory__*`, Codex `mingle_memory` server, OpenCode and Antigravity via ACP). Tools are pre-approved by name only for this server.

| Tool | Input | Notes |
|---|---|---|
| `mingle_memory_remember` | `kind, title, body, files?, commits?, commands?, evidence?` | Dedups/merges; returns `{id, revision, status, outcome, notices}`. |
| `mingle_memory_search` | `query?, kind?, includeStale?, limit?` | Returns compact entries with id + revision for later updates. |
| `mingle_memory_update` | `id, expectedRevision?, expectedHeadId?, kind?, title?, body?, files?, commits?, commands?, evidence?, note?` | Optional head identity binds the update to the exact result returned by search; stale identities conflict. Refuses pinned or retired entries. Passing `files` re-verifies and clears staleness. |
| `mingle_memory_retire` | `id, reason, expectedRevision?` | Tombstones the entry; refuses pinned entries. |

Search and write tool results include `headRecordId`. Agents should pass it as `expectedHeadId` alongside `expectedRevision` when updating or retiring an entry; this rejects a stale edit even when offline conflict resolution selects a different head with the same revision number. The human API requires both values, and the editor retains the exact head that was displayed when the correction began.

## Run context

Before each non-plan run, Mingle adds a bounded `Project memory` block (see `PROJECT_MEMORY_LIMITS`) to the run's injected context: up to 3 pinned entries, then entries ranked by relevance to the prompt (title/body token overlap, file-path mentions, evidence, recency), up to 2 stale ones clearly labelled. The block states that it is reference data. No model is invoked to build it and nothing runs at startup. Each injection is recorded (see `memory-injections`).

## Staleness

An entry is marked stale when the SHA-256 of a referenced file in the project root no longer matches the recorded `revision` (or `baseRevision`, for an author who worked in an isolated worktree). Checked: after every run ends, and when the list/detail/search/context endpoints are read (rate-limited per project). Referenced paths are de-duplicated across entries, hashes are cached against each file's (mtime, size) so unchanged files cost one `stat`, and every scan has a wall-clock budget (≈200 ms; 250 ms on reads) after which it stops and resumes from the same position on the next scan. Building a run's context never waits for a scan: it uses the last known stale marks and starts a background scan. Stale state is per device and does not create a revision or replicate. An update that supplies fresh `files`, or a human `lifecycle:"active"`, clears it.

## Team sharing

When the local project is bound to a team shared project (the same binding the team chat uses, read from local tables), every revision is signed by this device and sent to each mutually linked teammate device as `projectmemory.record` over the existing encrypted transport. No cloud schema or Supabase client change is involved: the only contract change is allowing the `projectmemory.*` message-kind namespace, which the cloud only length-checks. New or reconnecting devices ask for missed records with `projectmemory.sync.request` / `.response` (bounded batches of ≤50 records, ≤400 per request, resumable via `more`, requests served at most once per 10 s per peer).

**Event-driven only — nothing polls.** Publishing runs on a local write, when the Memory list for a team-bound project is opened (rate-limited to once per 30 s), and when the local transport topology (device, links, peers) changes; process start schedules one topology check. A failed send keeps the revision unpublished and arms a single exponential-backoff retry (15 s → 5 min) **only while unpublished work exists**; the timer is cleared when the queue drains. Unshared projects never send, never retry and report `unpublished: 0`. Binding and roster lookups read local SQLite caches; the only cloud-touching calls are the existing `authorizeTeam` and collaboration-members reads, made once per *received* envelope.

A received record is accepted only if: the transport authenticated its sender device and the envelope is addressed to this device, the sender is an active, mutually linked, non-revoked roster device, fresh team authorization passes, the team and shared project match this device's exact local binding, the sender's account is an active member, the record's `authorDeviceId` and Ed25519 signature verify against that device's registered key (direct records must be signed by the sending device; backfilled records may be relayed from any non-revoked team device), any claimed author account/device matches the device owner, the timestamp is not in the future, the content passes the secret/path/control-character filters, and it is not a replay (record ids are unique) or an entry ID in the exact retired-ID ledger. Permanently invalid records are dropped and logged, not retried; transient failures use the transport's bounded retry.

New records carry an independently signed causal proof binding the record id, entry id, parent record id and revision, operation, author device and kind, human control id and epoch, and protected flags (`pinned`, `retired`, `humanVerified`). A receiver checks each proof against the stored proof for its parent; it never trusts an asserted epoch or control id by itself. Agent records cannot create a control branch or change human-only flags, and cannot descend from a pinned or retired parent. If a descendant arrives before its parent proof, the signed record stays in history in a pending state and is re-evaluated after the requested ancestry arrives. It cannot become a head while pending. Human control branches at the same epoch use the control record id as a deterministic branch choice before revision comparison, so distinct concurrent controls and their descendants converge regardless of delivery order.

Signed causal proofs are kept in a compact persistent ledger separate from bounded revision bodies. Sync can serve those proofs after pruning, including to a newly joined third device; this preserves the chain needed to validate retained heads without retaining old content bodies. Legacy signed records are relayed with their original signed fields: absent lineage/proof fields remain absent on the wire and in the signing payload. Legacy records remain readable with the legacy conflict ordering; any old peer-supplied lineage without a proof is ignored as a causal baseline for new records. Local writes are durable first and published afterwards (`sharing.unpublished` is the queue).

Retired entry bodies and revision history are bounded, while a small persistent exact-ID ledger retains purged entry IDs to prevent resurrection. New unknown entry IDs are accepted regardless of timestamp; a global time floor is not used, since it could discard an unrelated valid offline create. The exact-ID ledger grows with retired IDs and contains no entry bodies.

## Known limitations

- Memory is shared with the whole team as soon as the project is team-bound; there is no per-entry "local only" switch (the secret filter and review UI are the safeguards). Retiring an entry replicates a tombstone but cannot unsend text a peer already received.
- Staleness is content-hash based, per device: a teammate with uncommitted edits can see an entry as stale that is fresh elsewhere.
- Search is deterministic token scoring over a bounded candidate set, not semantic/embedding search.
- Replication is eventually consistent. Concurrent agent edits descended from the same verified control branch use revision, author, time and record ID tie-breaks. Valid and ancestry-pending signed records remain available in history; invalid causal claims are rejected.
- Only devices that have signed a record can serve it in backfill; records written before a device was registered are signed and published once it registers.
- Backfill of more than 400 records per request needs several round trips (the requester chains them automatically).
## Known limitations

- Memory is shared with the whole team as soon as the project is team-bound; there is no per-entry "local only" switch (the secret filter and review UI are the safeguards). Retiring an entry replicates a tombstone but cannot unsend text a peer already received.
- Staleness is content-hash based, per device: a teammate with uncommitted edits can see an entry as stale that is fresh elsewhere.
- Search is deterministic token scoring over a bounded candidate set, not semantic/embedding search.
