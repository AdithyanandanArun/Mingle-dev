# Project collaboration API

This API is the project-first entry point for Mingle teammate invitations. It layers invitations over the existing verified-account, cloud-team, shared-project, device, transport, and local execution services; it does not add another transport or remote execution path. All endpoints are local `/api` routes and use the runtime's existing Host/Origin protection. Authenticated routes derive identity from the existing verified account session and Supabase `getUser()` validation, never from client-supplied account IDs or unverified JWT claims.

## Integration constructor

`apps/server/src/project-collaboration/service.ts` exports `ProjectCollaborationService`; `apps/server/src/project-collaboration/routes.ts` exports `registerProjectCollaborationRoutes(add, service)`. The concrete service constructor is:

```ts
new ProjectCollaborationService({ store, account, distributed, workspace, providers, emailSender? })
```

These are the existing `Store`, `AccountService`, `DistributedWorkspaceService`, `WorkspaceService` and `ProviderService`. The optional `emailSender` replaces only outbound sending for deterministic tests. The service itself resolves projects from `Store`, obtains canonical Git remotes through argv-only Git, revalidates the live account through `AccountService.withAuthenticatedClient`, bootstraps cloud team/project records through `distributed.teams`, registers the existing transport device, binds through `distributed.bindProject`, validates provider/model configuration through `ProviderService`, creates the idle session through `WorkspaceService`, and publishes it through the existing execution roster. It owns only additive local SQLite binding/idempotency records and does not open another transport.

The parent composition instantiates the service, calls `registerProjectCollaborationRoutes(add, service)`, and calls `service.close()` on shutdown. No domain adapters or changes to root routes, `app.ts`, existing distributed services, or transport wiring are required. Authenticated routes always use Supabase `auth.getUser()` through `AccountService`; caller-supplied account IDs and unverified JWT claims are never authority.

## Project snapshot

`GET /api/projects/:projectId/collaboration` returns:

```ts
{
  project: null | {
    teamId: string;
    sharedProjectId: string;
    name: string;
    repositoryUrl: string;
  };
  members: Array<{ accountId: string; email: string | null; displayName: string | null; role: 'leader' | 'admin' | 'member'; status: 'active' }>;
  agents: Array<{ id: string; name: string; accountId: string; deviceId: string; projectId: string; sessionId: string | null; provider: string | null; model: string | null; state: string }>;
  invitations: Array<{ id: string; email: string; role: 'member' | 'admin'; status: 'pending' | 'accepted' | 'revoked' | 'expired'; createdAt: string; expiresAt: string; invitedByAccountId: string }>;
  email: { configured: boolean; message?: string };
}
```

The snapshot's project `null` means that the local project has not yet been bootstrapped to an existing cloud team/shared-project record. Snapshot reads do not start inference, enroll devices, or create invitations. `agents` contains only the current device's explicitly published local agents and the remote agents already in the shared roster; private local sessions are not implied to be shared. New project-first teams receive an immutable database scope to exactly one shared project; project writes cannot add, reassign, or replace that scoped project. Existing manually managed teams without this scope retain their current multi-project behavior. Active team members can still see the shared-project rows allowed by the existing team policy; for a project-first team that is exactly its one scoped project, so accepting an invitation does not expose unrelated local projects or broader organization/account data.

## Create and deliver invitation

`POST /api/projects/:projectId/collaboration/invitations` accepts strict JSON:

```ts
{ email: string; role?: 'member' | 'admin' }
```

The target must be an existing source Git project and the caller an active leader. Existing canonical repository URLs are normalized to credential-free HTTPS/SSH forms from the local repository's configured origin; credentialed URLs, local paths, arbitrary remote URLs, and unsupported protocols are never emitted. The server bootstraps/reuses the existing team, shared project, one-project team scope, project binding, and source device registration before creating the invitation. Invitation tokens are high entropy, shown only inside the invite URL/email, persisted only as a cryptographic hash, expire after seven days, and are single-use. Inviting an already active team member is rejected unless it is an explicit recovery from an incomplete/expired prior invitation-bound enrollment or revoked device link. Re-enrollment never creates a duplicate membership or elevates an existing role. The response is:

```ts
{
  invitation: { id: string; email: string; role: 'member' | 'admin'; status: 'pending'; expiresAt: string };
  delivery: { status: 'sent' | 'not_configured' | 'failed'; message: string };
  joinUrl?: string; // only when email was not confirmed; token exists only in this response or email fragment
}
```

`sent` is returned only after the configured provider confirms the send request. The Edge Function's read-only status is authoritative for sender and landing-page readiness; desktop installations do not need the cloud `MINGLE_INVITE_JOIN_URL` environment variable. Missing sender or public landing configuration returns `not_configured` and retains the pending invitation for an explicit later resend path; provider failure returns `failed`. Neither status claims that the recipient opened or accepted the invitation. Resend sandbox restrictions are reported as `failed`, not as successful delivery. For `not_configured` or `failed`, the response includes a copyable `joinUrl`: an HTTPS static landing URL with the token in its fragment when the Edge Function reports a configured landing base, otherwise the `mingle://join?token=...` deep link. Tokens are never returned in other JSON fields, event payloads, logs, or database rows.

`POST /api/projects/:projectId/collaboration/invitations/:invitationId/delivery {}` rotates the token hash before retrying delivery and returns a replacement copyable URL when delivery is not confirmed. `DELETE /api/projects/:projectId/collaboration/invitations/:invitationId` revokes a pending invitation and invalidates enrollment authorization.

## Invitation landing and join

The public HTTPS landing page is hosted separately at the operator-configured Supabase Edge Function secret `MINGLE_INVITE_JOIN_URL` (a static GitHub Pages URL is suitable; no custom domain is required). The Edge Function does not use its own `text/html` response as the production landing page because Supabase's default `supabase.co` host can rewrite HTML to plain text. The function appends the token only as a URL fragment, never as a path/query/request URL. The static page uses `Referrer-Policy: no-referrer`, restrictive CSP and escaped text, and requires an explicit **Open Mingle** click to navigate to `mingle://join?token=<token>`. The desktop parses the custom protocol and immediately routes to local `/?join=<token>`; the token is held in memory and removed from browser history after consumption. Application logs, analytics and events redact both link forms.

`POST /api/project-invitations/preview` accepts `{ token: string }` and requires an authenticated, verified account whose current verified email exactly matches the invitation email after canonical normalization. It returns:

```ts
{ invitationId: string; projectName: string; repositoryUrl: string; email: string; expiresAt: string; role: 'member' | 'admin'; inviterDisplayName?: string; inviterEmail?: string }
```

Preview is non-consuming. The current preview RPC does not return public inviter display/email data, so those optional fields are omitted unless a deployment explicitly provides them. Expired, revoked, accepted-by-another-identity, malformed, or mismatched-email tokens return a generic not-found/invalid-invitation response without revealing project metadata.

The desktop first displays a confirmation and does not accept the invitation until the user completes the join flow. It defaults to cloning the advertised repository via `POST /api/projects/clone` into the selected parent/name; the user may instead select a registered project or open a local folder. `POST /api/project-invitations/join` accepts either the legacy single-agent shape or the new multi-agent shape, but exactly one of `agent` and `agents` must be present:

```ts
{
  token: string;
  localProjectId: string;
  // Legacy compatibility: exactly one agent.
  agent?: { provider: 'claude' | 'codex' | 'opencode'; model: string; effort: Effort; policy: 'supervised' };
  // New join wizard: one through four agents, in display/order-preserving sequence.
  agents?: Array<{ provider: 'claude' | 'codex' | 'opencode'; model: string; effort: Effort; policy: 'supervised' }>;
}
```

The chosen local repository must match the invitation's verified canonical repository identity. GitHub `git@github.com:owner/repo.git` and `ssh://git@github.com/owner/repo.git` origins are safely represented as their credential-free HTTPS repository URL; other credentialed/unsupported SSH forms are rejected with guidance to configure a safe origin. Provider choices follow the existing distributed execution roster's publishable Claude, Codex, and OpenCode agents, and are checked against the local provider/model/effort catalog. Acceptance activates team membership, consumes the invitation and creates an invitation-bound enrollment authorization restricted to the invited account, inviting leader device fingerprint, newly registered invitee device fingerprint, team, and the invitation's original seven-day expiry. The authorization is not extended on accepted retries; after expiry the leader issues a new invitation. It creates reciprocal device links only for those exact two devices, then creates/binds the selected local project to the existing shared project and creates each requested idle Supervised session before publishing the full session list. No provider inference, command dispatch, or background model task is run. Retries from the same account, device, and local project return the original ordered session set; retries with changed agent settings or from a different account/device/local project reject. Existing one-agent local join records are migrated into the expanded local idempotency table.

```ts
{ projectId: string; sessionId: string; sessionIds: string[]; teamId: string; sharedProjectId: string; alreadyJoined: boolean }
```

`sessionId` remains the first session for older consumers; `sessionIds` is the complete ordered set and is always returned, including for legacy one-agent requests.

The initial session remains local to that device. Remote execution is available only through existing exceptional recovery and execution approvals, and each run still requires the destination device owner's approval. Device enrollment never grants blanket trust to the team.

## Email delivery

Supabase Edge Function `project-invitation-delivery` authenticates the caller using the request JWT and calls `auth.getUser()` before authorizing invitation delivery. RLS-backed rows enforce active team-owner authority. The function uses the user JWT plus the pinned publishable key, never a service-role client; it prefers managed `SUPABASE_PUBLISHABLE_KEYS.default` and accepts legacy publishable/anon key variables. Gmail delivery uses server-only Edge secrets `SMTP_USER`, `SMTP_PASSWORD`, `MINGLE_INVITE_FROM`, and `MINGLE_INVITE_JOIN_URL`; `MINGLE_INVITE_FROM` must match the Gmail account address. Optional Resend transport uses `RESEND_API_KEY`, `MINGLE_INVITE_FROM`, and the same public landing URL. Readiness reports false until a sender and an HTTPS landing base without credentials/query/fragment are valid. No service credential is delivered to or stored by desktop clients. Resend sandbox restrictions and provider failures remain truthful; automated tests inject a sender and never contact real email addresses. Gmail SMTP uses implicit TLS at `smtp.gmail.com:465`; ports 25 and 587 are not assumed reachable from Edge Functions.

Every delivery attempt first claims atomic cloud rate limits scoped to team, inviter and normalized recipient: one attempt per minute and at most five attempts per rolling 24-hour recipient window, plus ten attempts per inviter per rolling hour and fifty per inviter per rolling day. Failed/uncertain sender outcomes consume an attempt and are not retried automatically. The delivery function accepts only an invitation ID and its matching bearer token; subject/body are constructed from the stored invitation and project data, never caller-provided content.

The invitation migration is additive and leaves existing account/team/project visibility policies intact. Review its SQL and RLS policy changes before any deployment; applying cloud SQL, setting sender configuration, and deploying the Edge Function are separate owner operations.
