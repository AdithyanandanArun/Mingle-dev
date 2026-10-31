# README screenshots

These PNGs show Mingle's actual interface with explicit **Example** data. They
contain no private account information. Agent activity, cloud collaboration,
and invitation delivery in these fixtures are simulated; the pictures do not
establish live provider or multi-device acceptance.

Captured on 2026-10-31 with the neutral, flat theme. The workspace and teammates
captures include the header correction at source commit `717a9a8`. The welcome
capture uses the same onboarding styles introduced in `728417a`.

| Asset | Capture workflow | Source screenshot |
| --- | --- | --- |
| `shared-workspace.png` | `node scripts/project-collaboration-browser-acceptance.mjs` | `member-shared-group.png` |
| `teammates.png` | Same workflow | `teammates-invite.png` |
| `welcome.png` | `node scripts/onboarding-browser-acceptance.mjs` | `welcome-desktop.png` |

The scripts use Playwright with a disposable local runtime and print their
screenshot directory. They require the workspace dependencies and an existing
Chromium executable. Copy the relevant PNGs here after reviewing them; do not
capture a real user's account or repository to refresh documentation assets.

The logo stays linked to its editable source at
[`apps/web/public/mingle.svg`](../../apps/web/public/mingle.svg).
