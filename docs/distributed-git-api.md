# Distributed Git and command service API

`GitSyncService` and `RemoteCommandService` live on the server and are composed by the application host. The host owns HTTP route registration and must provide the live account/team/device authorization adapter described below. These modules do not expose the local HTTP server to the network.

## Construction and authorization

Both constructors accept one options object:

```ts
{
  store,                       // Store or { db: DatabaseSync }
  account,                     // withAuthenticatedClient(callback), backed by AccountService
  transport,                   // snapshot(teamId?).deviceId and send({teamId,toDeviceId,kind,payload,idempotencyKey})
  workspace,                   // getProject(localProjectId)
  repository?,                 // optional runGit(cwd, argv, bounds) adapter; omitted uses the restricted argv-only runner
  authorizeTeam,               // required live authorization callback
  changed?,                    // local state-change notification
  resolveBinding?,             // optional host resolver when Store.getProject is not available
}
```

`authorizeTeam({teamId, peerDeviceId?})` must fail unless the signed-in account is still an active team member, the current team-scoped local device belongs to that account, and—when a peer is supplied—the peer device is active and the mutual device link/fingerprint pin remains valid. It is called for binding, snapshots, requests, incoming envelopes, owner decisions, and again immediately before any bundle-byte send, command dispatch, or Git mutation. Missing authorization is a construction error at the integration boundary; it is never interpreted as permission. `account.withAuthenticatedClient` must perform its normal verified `getUser()` check for each authority-sensitive operation.

Transport device identifiers are team-scoped. Services always use `transport.snapshot(teamId).deviceId`; an unscoped device snapshot is not an authorization identity. Incoming envelopes are expected to have already passed transport authentication/decryption, but the services still verify their team, destination device and sender link locally before accessing project state.

Both services expose:

- `bindProject({teamId, sharedProjectId, localProjectId})`: owner chooses an existing local project ID. The service canonicalizes and verifies its Git root, then stores that binding locally. No peer-supplied path, cwd or remote URL is used to select a repository.
- `snapshot(teamId?)`: async camelCase arrays of bindings, requests and append-only audit entries, filtered through current account/team/device authorization. Snapshots are local UI data; canonical local paths are never put in peer envelopes.
- `onEnvelope(envelope)`: handles only the service's documented `git.*` or `command.*` kinds.
- `decide({requestId, decision, expectedDigest})`: decision must include the immutable digest displayed in the local snapshot. Decisions derive team and peer identities from the stored request, never from decision-body fields.

SQLite request state and audit tables are created idempotently on the supplied local database. Audit tables reject UPDATE and DELETE. Bundle bytes and incomplete chunks are kept in the local SQLite database; snapshots and audit details never include bundle bytes or configured remote URLs.

## Git handoff

`GitSyncService.request({teamId, sharedProjectId, toDeviceId, expectedHead, baseHead?, branch?, idempotencyKey?})` creates a Git bundle from committed objects only. `expectedHead` must still be current HEAD. If `baseHead` is supplied it must be an ancestor and the bundle excludes that base; otherwise all history reachable from HEAD is considered. The bundle is capped at 16 MiB, SHA-256 hashed, divided into 128 KiB binary chunks (at most 128 chunks, leaving room for base64 and JSON within the 256 KiB transport payload limit) and retained locally. Only a `git.offer` containing metadata, expected hashes and sizes is sent at first. The source owner must approve that exact digest before any bundle chunk is published. An optional idempotency key reuses the same prepared request and never exports again.

On the destination, a bound project receives the offer as an `awaiting-destination-approval` request. Its owner approves the exact digest before the source receives `git.import-approved`. The source only sends the stored bytes once both source and destination approval are recorded. Chunks may arrive out of order; repeated identical chunks are harmless, while conflicting duplicates or hash/size mismatch fail the request. The import uses a generated `refs/mingle/incoming/<requestId>` ref. It never updates a checked-out branch or working file.

After verifying the bundle and exact advertised source HEAD, Git is fetched from a private temporary bundle path. An isolated no-checkout worktree with a separate index is used for ancestry and path-conflict inspection. Divergent commits with overlapping changed paths are conservatively reported as conflicts, even when a text merge might be clean. Unrelated histories are also conflicts. A changed target HEAD/fingerprint is reported as stale. The original working tree and index are untouched by import.

`requestIntegration({teamId, sharedProjectId, incomingRequestId, action, expectedHead, expectedFingerprint, remoteName?, idempotencyKey?})` creates a *local-only* owner approval request. The optimistic fingerprint covers HEAD, branch, staged/unstaged changes, bounded untracked file contents and local Git config. `merge` requires a clean project, a current imported request with no reported overlap and no configured external merge driver/content filter. Approval rechecks HEAD and the fingerprint, then performs a fast-forward or an ordinary no-ff merge with hooks disabled. `push` requires an owner-selected configured remote, a named branch and a credential-free HTTPS/SSH destination; it pushes exactly `HEAD:refs/heads/<current-branch>` without force. Hooks, external diff/textconv, helper and `ext` protocols are disabled. Neither action is triggered by a peer message, and neither is automatically retried.

An interrupted import or Git mutation changes to `unknown` during restart recovery. Incoming chunks still in the `receiving` state are safe to resume because each index is immutable and hash-checked. A dispatched source transfer with uncertain mailbox delivery also becomes `unknown`; it is not automatically resent.

## Team artifact transfer

`GitSyncService.exportTeamArtifact({teamId, sharedProjectId, sourceWorktreePath, revision, baseRevision?, toDeviceId, deliveryId, taskId?, path?})` and `importTeamArtifact({teamId, sharedProjectId, deliveryId, artifact, sourceDeviceId?})` support the team-orchestration delivery lifecycle. These are not public caller-selected Git operations: the device executor and host supply locally resolved repository/worktree paths and delivery identities. `DistributedWorkspaceService` rechecks the team/device authorization and uses the repository mutation lease for imports.

The sender emits a bounded offer and encrypted binary chunks using `git.team-artifact.offer` and `git.team-artifact.chunk`; no raw bundle bytes are written to the source repository. Each bundle is capped at 16 MiB and divided into 128 KiB chunks (maximum 128), matching the normal Git mailbox limits. The receiver validates offer dimensions, sender/delivery ownership, exact chunk sizes, duplicate consistency, whole-bundle SHA-256, `git bundle verify`, and the advertised commit tip before the bundle becomes importable. Duplicate identical chunks and imports are idempotent; changed duplicate data, wrong senders, oversized input, missing delivery authority, or a ref/tip mismatch are rejected. Uncertain transfers are not automatically replayed.

The receiver cannot prove that its object database contains a sender-provided base before the transfer begins. To avoid thin bundles that fail on a receiver with unrelated or incomplete history, team artifact bundles conservatively contain all history reachable from the requested revision. `baseRevision`, when supplied, must be an ancestor and is retained as delivery metadata, but does not reduce the bundle. The 16 MiB limit therefore applies to full reachable history for each artifact revision; a larger bundle fails explicitly.

Import writes only the claimed commit to a collision-resistant isolated ref under `refs/mingle/team/<project-segment>/<delivery-segment>/<revision>`. It does not update HEAD, a branch, the index, or working files. The project and delivery path segments are sanitized and suffixed with hashes; the full object ID is used for the revision segment. The host stores the resulting ref with the delivery and includes it in the orchestrator result, which can use an explicit `git merge` or `git cherry-pick` after review. No artifact is merged or pushed automatically.

Ordinary `git.offer` transfers retain the exact source- and destination-owner approvals described above. Team artifact transfer instead relies on the team's previously accepted agent consent and rechecks active team membership, mutual device links, the integration device recorded on the delivery, the owning agent/device, active roster membership and current consent before sending or importing. This narrower authorization is limited to committed bundle transport and isolated-ref creation. Received commits are still peer-provided source: Git is not asked to check them out, run repository hooks, clean/smudge filters, textconv, or external diff helpers, and an isolated ref is not evidence that the code is safe or correct.

Transport kinds handled by `GitSyncService`:

| Kind | Direction | Purpose |
| --- | --- | --- |
| `git.offer` | source → destination | Bounded immutable transfer metadata, no source bytes |
| `git.import-approved` | destination → source | Destination owner's exact import consent |
| `git.bundle.chunk` | source → destination | One approved base64 bundle chunk |
| `git.result` | destination → source | Import result, conflicts or stale state |
| `git.team-artifact.offer` | producer → integration device | Consent-scoped bounded team artifact metadata |
| `git.team-artifact.chunk` | producer → integration device | One bounded encrypted team artifact chunk |

## Remote commands

`RemoteCommandService.request({teamId, sharedProjectId, toDeviceId, operation, cwd?, idempotencyKey?})` sends a typed request. The supported operations are `git.version`, `git.status`, `git.head`, `git.branch`, `git.log` (limit 1–50), `git.showStat` (commit object ID), and `git.diffStat` (two commit object IDs). Requests do not accept executable names, arbitrary argv, shell text or environment variables. No `node`, Python, shell, package manager, script runner or write-capable Git command is allowed.

The destination records the exact operation, resolved target project HEAD/fingerprint and relative cwd as `awaiting-approval`; no process starts before owner approval of the request digest. Cwd must be relative and inside the owner-bound project. Each component is checked for symlinks, `..`, absolute paths and realpath escape both on receipt and immediately before dispatch. Output is capped at 64 KiB and each process has a 10-second deadline. This narrow process allowlist is not an OS sandbox.

The receiver sends `command.result` only after owner denial or a recorded execution outcome. A duplicate envelope with the same immutable request ID/payload is ignored; a changed payload under that ID is rejected. Before dispatch, the service durably marks the request dispatched. If the service restarts during dispatch, the request becomes `unknown`, is surfaced in the snapshot, and is never run again automatically. The transport's idempotency key is stable for each request/result envelope.

## Parent route integration

The route layer should import request and decision schemas from `packages/contracts/src/remote-git.ts` (and export them through `packages/contracts/src/index.ts` during integration). Suggested handlers are:

- `GET /api/distributed/snapshot?teamId=...` → combined account-scoped service snapshots.
- `POST /api/distributed/projects/bind` → `DistributedProjectBindingSchema`.
- `POST /api/distributed/git/request` → `GitTransferRequestSchema`.
- `POST /api/distributed/git/:requestId/decision` → `DistributedRequestDecisionSchema` with route/body ID equality checked.
- `POST /api/distributed/git/integration` → `GitIntegrationRequestSchema`.
- `POST /api/distributed/commands/request` → `RemoteCommandRequestSchema`.
- `POST /api/distributed/commands/:requestId/decision` → `DistributedRequestDecisionSchema` with route/body ID equality checked.

All routes remain local and use the application's existing Host/Origin protections. The route host wires transport `onMessage` delivery to each service's `onEnvelope`; it should not accept a caller-supplied owner ID, filesystem path, remote URL, bundle bytes or raw command string.
