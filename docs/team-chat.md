# Team chat

Team chat is one durable conversation per Mingle shared project. It is the project-level place where a person can post a request and a locally owned shared agent can reply. Teammates see the same timeline after their devices are paired and the encrypted mailbox has synchronized.

## What it does

- **Project binding:** `GET /api/projects/:projectId/team-chat` requires the local project to be bound to a shared project. The response includes paginated messages, active teammates, published local and remote agents, and the actual transport/device status.
- **Human messages:** `POST /api/projects/:projectId/team-chat/messages` validates the body and roster mentions, stores the message in SQLite, then sends it to every active mutually linked device through the existing encrypted device mailbox. Message IDs make retries and duplicate mailbox delivery idempotent. Ordering is `createdAt`, then ID.
- **Backfill:** Opening an empty or previously opened chat sends `teamchat.sync.request` with the latest timestamp (or `null`) to linked peers. A peer replies with at most 200 messages per response and at most 180 KiB per batch. Backfill is requested at most once per project per 30 seconds on a device. It includes history the responding device already has; repeated delivery is deduplicated locally.
- **Session history:** The chat's **Share this session's history** control imports the latest 200 durable user/assistant messages from one local session. The existing credential scrubber runs before they enter the shared chat. Tool output, attachments, approvals, system messages and hidden reasoning are not imported. Per-session/message source IDs prevent duplicate imports. Imported messages fan out as bounded sync-response batches.
- **Local agent mentions:** Selecting a local published agent runs that agent's existing local session through `SessionRuntime.start`, using the message as the request and a small recent-chat excerpt as explicitly untrusted context. The run still uses the session's existing provider, workspace and local approval policy. Its final assistant text is scrubbed, saved as an agent message and distributed to linked devices.
- **Remote agent mentions:** The timeline shows the remote agent and owner, but conversational remote execution is not wired. It posts a visible failure explaining that no execution request was created. Remote execution remains available only through the existing recovery request flow, which requires its own evidence and owner approval; team chat does not bypass those checks.

The sidebar link appears only when the server reports a shared-project binding. `openTeamChat(projectId)` is also exposed by the web store so the join flow can open the conversation after enrollment.

## Trust and delivery

Transport authenticates and decrypts the mailbox envelope and checks the current device registration and mutual fingerprint links. Team chat independently parses every `teamchat.*` payload with strict Zod schemas, verifies the sender device and active account membership, checks the team/shared-project relationship and local binding, and validates authors in the active team before persisting. The remote sender cannot choose a local project path or start another device's provider session.

SQLite is the local durable history. `sending`, `sent` and `failed` describe the local view of delivery. `sent` means Mingle durably accepted the encrypted envelope into its local outbox; it does **not** mean the cloud relay accepted it, the peer opened the chat, or an agent ran. The composer and connection banner show the transport's current status and mutual-link counts. If delivery fails, the local message remains visible and retry/backfill can reconcile later.

Message text and author metadata are shared only with devices whose owners are active team members and whose device fingerprints are mutually linked. Teammate display names and all message text are data, not instructions. Agent context is length-bounded and labelled untrusted. Human text, imported session text and agent replies pass through Mingle's existing best-effort credential scrubber before persistence or sharing.

## Limits and verification

- Message bodies are limited to 20,000 characters and mentions to 20 agents.
- REST pages contain up to 200 messages. Backfill returns the latest applicable bounded batch; older history can be imported explicitly from a local session.
- A history import is capped at 200 durable user/assistant messages and exposes whether earlier messages were omitted.
- A local agent session that is already active cannot be run a second time from team chat. Its request is marked failed rather than silently queued.
- Remote conversational agent runs and owner approval cards in the team-chat view are not implemented.
- SQLite migration 19 creates the local message table and import-deduplication index. Team chat uses the existing distributed-team cloud tables; it adds no cloud transcript table.

Focused tests use fake provider adapters for local-agent dispatch and exercise fan-out, duplicate handling, membership rejection, backfill batch bounds, HTTP history import, and two-app encrypted mailbox delivery. No paid model inference is used by those tests.
