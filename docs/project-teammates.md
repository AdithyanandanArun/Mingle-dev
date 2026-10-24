# Project teammates

The primary collaboration flow starts from an existing Git project. Advanced team/device settings remain available for diagnostics; inviting a teammate does not require manually creating a team, exchanging invitation tokens, registering devices or copying fingerprints between settings pages.

## Leader and teammate flow

1. Open a Git project with a shareable repository origin and choose **Add teammates**, next to **Add agent**. Sign in to a Mingle account if prompted.
2. Enter the teammate's email address and send the invitation. The app prepares the project's shared team record, local binding and device identity. A successful email status means the sender accepted the message, not that it reached the inbox or was opened. If delivery is unavailable, the UI reports that state and can expose the private join link for manual sharing.
3. The teammate opens **Join project** from the email, then **Open Mingle** on the invitation page. The installed app validates the link and asks **Join <project>?** before proceeding. **Not now** closes without accepting.
4. The teammate signs in with the exact invited account, chooses a destination parent and checkout folder name (cloning is the default), or selects an existing checkout/local folder. Mingle creates the clone only after the destination is chosen. The checkout's canonical Git origin must match the invitation repository; private-repository Git access remains local to the teammate.
5. The teammate chooses one or more supported provider/model/reasoning-effort combinations (up to four). Joining provisions idle Supervised agents and publishes all of them to the shared project roster. It starts no inference and does not copy provider credentials. After success, Mingle selects the project and first agent; **Open team chat** continues into the shared conversation when available.
6. The invitation authorizes pairing only the inviting leader's device and the joining teammate's device. The accepted account, team, device IDs and current fingerprints must match. This replaces the manual fingerprint exchange for this invitation flow; it does not trust every device in the team.
7. The project agent controls show local and published teammate agents with their reported owner/device/provider/state. Local agent controls retain their existing behavior. A remote device owner retains execution and provider-spending authority.

Each person still needs Git access to the repository. A Mingle invitation does not grant GitHub access or upload local files. Private repository authentication stays with the person's local Git setup. Joining rejects a different repository checkout rather than silently binding it.

Invitation authority belongs to the existing Mingle project team. Joining does not let a teammate invite people into that team. A separate checkout can have an independent Mingle team using the same repository origin; it receives no membership, devices, agents, messages or authority from the original team. Repository URLs do not establish a global owner across independent workspaces.

Remote execution retains the exceptional-recovery policy in [the implementation contract](implementation-contract.md). Seeing or selecting an agent is not an execution grant. Device-owner approvals, provider-spend consent, Git transfer/import decisions and merge/push approvals remain separate.

## Email sender setup

The `project-invitation-delivery` Supabase Edge Function owns email delivery. The desktop calls it with the signed-in user's session. It verifies the user, invite ownership, pending state and template data before sending. It must not accept arbitrary recipients, bodies or sender credentials from a desktop request.

For the selected Gmail route, configure these **Edge Function secrets** in the intended Supabase project:

| Name | Value |
| --- | --- |
| `SMTP_USER` | The Gmail address that owns the sender account. |
| `SMTP_PASSWORD` | A Google app password for that account, entered directly into Supabase's private secret settings. |
| `MINGLE_INVITE_FROM` | A sender name and the same Gmail address, such as `Mingle invitations <your-account@gmail.com>`. |
| `MINGLE_INVITE_EMAIL_PROVIDER` | `smtp` for Gmail delivery. |
| `MINGLE_INVITE_JOIN_URL` | The published HTTPS join page, for example `https://<account>.github.io/Mingle-dev/join/`. |

Gmail submission uses implicit TLS to `smtp.gmail.com:465`. The app password never belongs in the desktop, a checked-in `.env`, logs, an invitation URL or a test fixture with real credentials. This configuration is distinct from Mingle Google sign-in; normal account sign-in does not authorize Gmail sending. Google requires 2-Step Verification for app passwords, and some managed or protected accounts cannot create them. See [Google's app-password guide](https://support.google.com/accounts/answer/185833).

Supabase's hosted runtime blocks SMTP ports 25 and 587. Its default domain also rewrites HTML GET responses to plain text, so the invitation landing page is hosted separately. See [Supabase function limits](https://supabase.com/docs/guides/functions/limits).

The optional Resend path uses server-side `RESEND_API_KEY` and `MINGLE_INVITE_FROM` with the same join-page setting; it requires a verified sending domain. Do not configure the test `resend.dev` sender and represent it as unrestricted teammate delivery.

## Join-page publication

The static files in [website/join](../website/join) contain no account keys or backend access. The invitation token is in a URL fragment, which is not sent to the page's HTTP server. The page removes it from browser history immediately, holds it in memory, and opens Mingle only after the user's click. No analytics or third-party resources receive it.

The manual [invitation-page workflow](../.github/workflows/project-join-page.yml) stages only public page files and deploys them to GitHub Pages. Before running it, enable Pages with **GitHub Actions** as its source in repository settings. This publication is separate from implementation and requires the owner's permission. Set `MINGLE_INVITE_JOIN_URL` to the resulting `/join/` URL after publication; do not guess that an unpublished URL works.

Deploy the reviewed project-collaboration migration and delivery function to the same Supabase project as the app's account connection. The public static page does not replace account/email checks: preview and acceptance run through authenticated invitation RPCs. The deployed Google sign-in app was switched to In production on 2026-10-24; basic identity sign-in no longer needs a tester allowlist.

## Validation boundaries

Automated checks use explicit account/SMTP/cloud fixtures and do not send email to real teammates or run a model. Tests must cover malformed links, header injection, failure to authenticate/send, expired or wrong-account invitations, revoked device authority, repeated/concurrent multi-agent joins, join-shape validation, and no inference during onboarding. The browser flow must verify the Add teammates entry point, multi-agent selection, actual request bodies, clone/setup failures and narrow layouts.

Live acceptance additionally needs an authorized sender, a published join page, a real invitation delivered to a tester, acceptance in installed Mingle on that tester's device, and the leader seeing the reported teammate agent. Record those observations separately from fixture results. Native Windows handler registration also needs a Windows installation check; syntax/parser tests alone do not establish it.
