# UI polish acceptance — 2026-10-27

This pass introduces a first-launch welcome flow, a provider-aware model picker, and a consistent visual treatment for the workspace and project collaboration screens. It does not start provider inference during setup or browser acceptance.

## Behavior

- Welcome guides optional Mingle account sign-in, local provider availability, and entry into the workspace. Completion is stored in device settings, so it is independent of the desktop loopback port. General settings can replay the tour.
- Invitations take precedence over welcome. A handled invitation does not reopen welcome over the joined project during the same launch; browser popout windows skip the tour.
- Model selection uses reported provider catalogs, preserves saved unknown selections, and retains provider/run locks. The provider rail, search, and model rows support keyboard navigation.
- Teammates prioritizes email invitations, presents current-session sharing and permissions together, groups local/remote agents, and puts optional notes/tasks in a disclosure. Consent and automatic current-session sharing remain authoritative.
- Shared transcripts, result cards, join steps, Team Structure, and the Settings Team workspace receive clearer hierarchy and spacing. Workspace chrome uses neutral charcoal surfaces, readable secondary text, blue accents, and restrained motion.
- Decorative motion respects `prefers-reduced-motion`; existing dialogs retain their dismissal lifecycle.

## Verification

All final checks passed:

| Check | Result |
| --- | --- |
| Web and server TypeScript | Both passed |
| Web Vitest | 3 files, 5 tests |
| Server HTTP/settings/restart suite | 12 tests; fresh welcome default, invalid version rejection, completion survives service restart |
| Project collaboration browser acceptance | 18/18 checks |
| Distributed Team workspace browser acceptance | 24/24 checks; account/team scoping, exact consent digests, 900px/narrow layouts, no vertical tab-strip overflow |
| Onboarding browser acceptance | First launch, optional example auth error/retry/pending/success/cancel, save/reload, replay, focus trap/return, provider guidance, invitation/popout priority, interrupted save, explicit replay after invitation, reduced motion, 900px/360px |
| Model picker browser acceptance | Search, caret keys, keyboard selection, Escape focus return, Tab wrapping, unavailable/locked providers, saved unknown models, outer/list scrolling and resize |
| Account storage browser acceptance | All 11 cases passed with the existing example-account fixtures |
| Production Vite build | Passed; existing Zod annotation warnings only |
| Served production UI smoke | Welcome completion, model popup, light theme, 900px/360px without page overflow; no uncaught page errors |

The served production smoke used a disposable example workspace and `FakeProviders`, with no real sign-in or inference. The full backend suite was not rerun for this UI pass.

## Regressions found and corrected

- The optional teammate note/task disclosure inherited a grid layout and allowed the task form to cover the note button. Block flow for the disclosure fixes the overlap and restores the eligibility status visibility.
- Model picker resize/scroll positioning, search caret navigation, focus transfer, and the set of tabbable controls were corrected during browser acceptance.
- The settings schema accepted welcome completion but the store allowlist omitted it. Adding the optional default makes completion durable; HTTP restart and invalid-value regressions cover the boundary.
- An independent Luna review identified a pending welcome completion callback that could navigate to provider settings after an invitation preempted the tour. The continuation now checks mount state; incoming invitations clear the pending tour/replay state. A held-save browser regression verifies that late completion does not navigate and that explicit replay still works after invitation dismissal.

## Screenshot evidence

- Final welcome: `/tmp/mingle-ui-polish-onboarding-final.png`
- Final workspace: `/tmp/mingle-ui-polish-workspace-final.png`
- Final light theme: `/tmp/mingle-ui-polish-light-final.png`
- Final production picker: `/tmp/mingle-ui-polish-picker-final.png`
- Picker catalog fixture: `/tmp/mingle-model-picker-acceptance-411060/`
- Welcome/mobile/regression screenshots: `/tmp/mingle-onboarding-acceptance-417587/`
- Teammates/join/shared member screens: `/tmp/mingle-project-collaboration-acceptance-416425/`
- Team workspace/map: `/tmp/mingle-distributed-browser-acceptance-417267/`
- Account recovery: `/tmp/mingle-account-storage-acceptance/`

These images are local acceptance artifacts, outside tracked source.

Browser fixtures label example accounts, teams, cloud responses, and models explicitly. Positive cloud/auth/email responses in these harnesses do not establish live OAuth, email delivery, physical-device transport, or provider execution. Native desktop packaging and OS-specific behavior are outside this visual acceptance pass.

The collaborative browser opened the served production app; page evaluation verified the welcome and provider stages. Its snapshot operation twice failed with `Preview automation snapshot timed out after 15000ms.` A focused click also returned `Preview automation click timed out after 15000ms.` Screenshots and deterministic interaction coverage therefore use the repository's existing Playwright workflow with the already cached Chromium executable; no browser or dependency download is required.
