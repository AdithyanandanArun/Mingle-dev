# Autonomous project memory

Agents remember, update, recall and retire project knowledge (decisions, conventions, gotchas, facts, verification results) on their own, without a human approving each entry and without any background model running. People can read, search, edit, pin and retire the same entries. Teammates' devices share it over the existing authenticated, encrypted device transport.

Memory is **data, never instructions or permission authority**. It is injected into a run as a labelled, JSON-encoded reference block, it cannot change a run's policy or approvals, and an entry that tells an agent to ignore its instructions is just text in a field.

Contract: `packages/contracts/src/project-memory.ts` (Zod schemas + types, exported from `@mingle/contracts`). Server: `apps/server/src/project-memory/`.

## Data model

| Field | Meaning |
|---|---|
| `kind` | `decision` \| `convention` \| `gotcha` \| `fact` \| `verification` |
| `status` | `tentative` or `evidenced`. **Only the server assigns `evidenced`**, and only when at least one reference was verified (see Evidence). An agent asking for `evidenced` without a verifiable reference gets `tentative` plus a notice. |
| `lifecycle` | `active`, `stale` (a referenced file's content no longer matches what was recorded, *on this device*), or `retired` (tombstone). |
| `pinned` | A person pinned it. Pinned entries are always offered to runs first (max 3) and **agents cannot edit or retire them**. |
| `humanVerified` | A person created, edited or re-verified it. Any later agent edit clears it. |
| `revision` | Integer starting at 1; increases by one on every durable change (content, pin, retire, restore). Stale marking does **not** change it (it is per-device state). |
| `author` / `updatedBy` | `{kind:'agent', sessionId, runId, name, provider, model, accountId, deviceId}` or `{kind:'human', displayName, accountId, deviceId}`. Always taken from the authenticated run or the signed-in account — never from tool arguments or request bodies. |
| `files[]` | `{path, revision, baseRevision, verifiedAt}`; `path` is project-relative, `revision` is a SHA-256 prefix computed by the server. |
| `sources[]` | Server-verified non-file provenance: `commit` (exists in the project repo), `run` (belongs to this project), `command` (ran in this run and exited 0). Unverifiable references are dropped with a notice. |
| `stale` | `null`, or `{since, reason, paths}` explaining which files changed. |
| `origin` | `{local:true}` if last written on this device, else `{local:false, deviceId}` of the teammate device that sent it. |
| `match` | Only on search results: `{score, fields}`. |

### Evidence rules

- A file reference is verified by the server reading the file inside the run's worktree (symlinks resolved, must stay inside it) and hashing it.
- `verification` entries need a verified `command` (the run's recorded tool call exited 0) or `run` reference to be `evidenced`.
- Humans' entries are `tentative` unless they carry a verified reference, but are marked `humanVerified`.

### Safety filters (applied to agent and human writes, and re-applied to every received team record)

- Writes containing secret-looking material (private keys, bearer/API tokens, `password=` assignments, long high-entropy strings, cloud key prefixes) are **rejected**, not redacted.
- File paths must be project-relative, without `..`, absolute roots, NULs or backslash tricks, must not be inside `.git/` and must not look like credentials (`.env*`, `*.pem`, `id_rsa*`, `.ssh/`, `.aws/`, …). Rejected paths are dropped with a notice; the entry is still stored if the rest is valid.

### Bounds

500 live entries per project, 2,000 retired tombstones, 50 revisions per entry (first revision kept), 8 files, 120-char titles, 1,500-char bodies, ≤25 agent writes per run, ≤10 search results, run context ≤8 entries / ≤4,000 chars. Duplicates are merged: writing an entry with the same normalized kind+title or body as a live one updates it (`outcome: 'merged'` / `'unchanged'`) instead of adding a second.

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
  "title": "…", "body": "…", "kind": "gotcha",
  "files": ["src/a.ts"],            // replaces file refs; the server re-hashes. [] clears.
  "pinned": true,                   // pin / unpin
  "lifecycle": "retired",           // retire (tombstone) — or "active" to restore a retired entry
  "note": "why"                     // optional, ≤300 chars, stored on the revision
}
```

At least one change besides `expectedRevision`/`note` is required. Returns `ProjectMemoryWriteResult` with the new revision. Humans are never locked out by `pinned`. Sending `lifecycle:"active"` on a **stale** entry re-hashes its files against the current project files and marks the entry `humanVerified` (this is the "still true" action); if a referenced file no longer exists the entry stays stale and a notice says so. `humanVerified` becomes true on any human content edit.

### `GET /api/projects/:projectId/memory/context-preview?query=`

`ProjectMemoryContextPreview` — what a run started now with that prompt would receive: `{ injection: {at, query, entries[{id,revision,title,kind,lifecycle,pinned,reason}], chars, truncated}, text }`. `text` is the exact block injected. Read-only.

### `GET /api/sessions/:sessionId/memory-injections?limit=20`

`ProjectMemoryInjectionsResponse` — the most recent memory blocks given to that session's runs (`runId`, `at`, entries with the revision that was shown and why: `pinned|relevant|recent|stale`). 404 for unknown sessions. Retained for the newest 200 injections per project.

### `POST /api/projects/:projectId/memory/sync`

Asks linked teammate devices to resend memory this device is missing (also happens automatically when the project is opened and periodically). Body `{}`. Returns `202 { "requested": <peer count> }`; `409` when the project is not team-shared or this device is not registered.

### Workspace events

Delivered on the existing `/ws` `state.changed` events (`WorkspaceEvent`, `projectId` set): `memory.updated` `{entryId, revision, op, origin:'local'|'peer'}`, `memory.stale` `{entryIds}`, `memory.injected` `{sessionId, runId, count}`. Refetch the list/detail on these.

## Agent tools (`mingle_memory` MCP server, run-scoped)

Same pattern as `mingle_progress`: a per-run bearer token on `/api/memory/mcp`, revoked when the run ends, absent from read-only plan runs. Supported on all four providers (Claude `mcp__mingle_memory__*`, Codex `mingle_memory` server, OpenCode and Antigravity via ACP). Tools are pre-approved by name only for this server.

| Tool | Input | Notes |
|---|---|---|
| `mingle_memory_remember` | `kind, title, body, files?, commits?, commands?, evidence?` | Dedups/merges; returns `{id, revision, status, outcome, notices}`. |
| `mingle_memory_search` | `query?, kind?, includeStale?, limit?` | Returns compact entries with id + revision for later updates. |
| `mingle_memory_update` | `id, expectedRevision?, kind?, title?, body?, files?, commits?, commands?, evidence?, note?` | Refuses pinned or retired entries. Passing `files` re-verifies and clears staleness. |
| `mingle_memory_retire` | `id, reason, expectedRevision?` | Tombstones the entry; refuses pinned entries. |

## Run context

Before each non-plan run, Mingle adds a bounded `Project memory` block (see `PROJECT_MEMORY_LIMITS`) to the run's injected context: up to 3 pinned entries, then entries ranked by relevance to the prompt (title/body token overlap, file-path mentions, evidence, recency), up to 2 stale ones clearly labelled. The block states that it is reference data. No model is invoked to build it and nothing runs at startup. Each injection is recorded (see `memory-injections`).

## Staleness

An entry is marked stale when the SHA-256 of a referenced file in the project root no longer matches the recorded `revision` (or `baseRevision`, for an author who worked in an isolated worktree). Checked: when a run finishes (its changed paths), when the list/detail/context endpoints are read (rate-limited per project), and when a retrieval is built. Stale state is per device and does not create a revision or replicate. An update that supplies fresh `files`, or a human `lifecycle:"active"`, clears it.

## Team sharing

When the local project is bound to a team shared project (the same binding the team chat uses), every revision is signed by this device and sent to each mutually linked teammate device as `projectmemory.record` over the existing encrypted transport (no cloud schema change; the only contract change is allowing the `projectmemory.*` message kind namespace). New or reconnecting devices ask for missed records with `projectmemory.sync.request` / `.response` (bounded batches, resumable via `more`).

A received record is accepted only if: the transport authenticated its sender device, the team and shared project match this device's exact local binding, the sender's account is an active member, the record's `authorDeviceId` and signature verify against that device's registered key (for backfill, any non-revoked team device), the claimed account matches the device owner, the timestamp is not in the future, the content passes the secret/path filters, and it is not a replay (record ids are unique) or older than a purged tombstone. Concurrent writes to one revision number are both kept in history; the head is the highest `(revision, at, id)`. Agents' records are rejected when they target a pinned entry or would resurrect a retired one; only a person can restore.

Local writes are durable first and published afterwards (`sharing.unpublished` shows the queue); a retry timer republishes after outages or restarts.

## Known limitations

- Memory is shared with the whole team as soon as the project is team-bound; there is no per-entry "local only" switch (the secret filter and review UI are the safeguards). Retiring an entry replicates a tombstone but cannot unsend text a peer already received.
- Staleness is content-hash based, per device: a teammate with uncommitted edits can see an entry as stale that is fresh elsewhere.
- Search is deterministic token scoring over a bounded candidate set, not semantic/embedding search.
