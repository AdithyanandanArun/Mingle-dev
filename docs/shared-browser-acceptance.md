# Shared browser acceptance — 2026-10-30

Implementation is on `feature/shared-browser`. This records local source/build verification, not a new published or installed release.

## Verified behavior

- Electron hosts sandboxed, context-isolated pages with Node integration disabled. Its private loopback relay rejects missing/wrong bearer authorization and browser Origins. Native toolbar input requires authenticated proof of the exact session/target's current presentation; a claimed native client ID alone is insufficient.
- Native clicks/keys/wheels acquire human control and return it after idle. Keep control and Hand back work without a video-stream connection. A held native drag does not expire. Streamed overlay input uses its own viewer identity, then returns to the native view after dismissal.
- Main/popout ownership bookkeeping prevents a late hide in the old window from parking a view owned by another window. Full-view dialog ancestors are distinguished from separate overlays covering the page.
- Separate CDP attachments have independent lifetimes. The temporary identification attachment can detach without disconnecting page automation. Detach events go to the correct parent, and iframe/worker events retain their child session identity.
- The relay stamps its dispatched mouse/key/touch input with timestamp zero. The isolated guest excludes those events from native input reporting; physical/native input is not suppressed by a 500 ms window. This mechanism is checked against the installed Electron runtime and must be rechecked on future upgrades.
- Native cookie storage round-trips synthetic regular and `__Host-` cookies without widening host-only scope. Profile import has separate fixture checks for site selection, normalization and known encryption formats. No real Google login or personal cookie import was performed.
- Fresh settings prefer embedded browsing, automatic tab opening honors the preference, and web-only runtimes fall back to managed Chromium. Previously saved browser choices are preserved. Provider subprocess environments omit the unrestricted desktop relay connection and receive their run-scoped MCP capabilities separately.

## Checks

All tests use disposable local Example workspaces or synthetic inputs. No inference was requested, no cloud writes or email were sent, and no installed Mingle profile was used.

- Focused server/browser/provider suites: **85 passed**, 15 files. Includes browser import, sandbox detection/profile generation, authorization, service routes and provider environment/adapter checks. Log: `/tmp/mingle-browser-server-focused.log`.
- Complete web unit suite: **41 passed**, 11 files. Log: `/tmp/mingle-browser-web-tests.log`.
- Embedded relay/host/user-agent plus browser preload tests: **19 passed**. Log: `/tmp/mingle-browser-desktop-tests.log`.
- Full desktop acceptance: **13 checks passed** via `node scripts/shared-browser-desktop-acceptance.mjs`. It launches the actual app with fresh Linux XDG/runtime directories and a local fixture website. Covers automatic connection mode, toolbar navigation, native hold/release, absent renderer Node APIs, native-input takeover and drag/idle behavior, hidden-target rejection, exact presentation restoration, full view, and streamed overlay input/return. Log: `/tmp/mingle-browser-resume-acceptance/final.log`; its JSON output gives screenshot locations.
- Extended `apps/desktop/embedded-browser/smoke.mjs`: passed with sandbox enabled and isolated XDG config/data/cache. Verified form interaction after CDP identification detach, cookie round-trip, screenshot, accessibility snapshot, screencast frames, and native-versus-agent input attribution. Log: `/tmp/mingle-browser-resume-final-smoke.log`.
- Server and web TypeScript checks, desktop/script syntax, production Vite build and `git diff --check`: passed. Build log: `/tmp/mingle-browser-resume-web-build.log`.

The native harness uses direct CDP connections to the test app/guest to inject UI input; the separate smoke also uses Electron's native `sendInputEvent`. This is automated input-path acceptance, not a physical keyboard/mouse test. Screenshots of the guest and outer page are separate because page-level capture does not reliably composite native child views.

Independent Codex Luna review at `0626386` found no concrete blocking issue in the reviewed relay, native authorization, provider environment filtering or view ownership. The subsequent default-selection change has focused service tests and the desktop acceptance check above.

## Device limits

Native acceptance ran on Arch Linux. Real Ubuntu AppArmor policy installation, Windows/macOS native behavior, and ordinary-user Google login remain unverified. The built-in mode avoids a separate Chromium download but does not disable the OS sandbox or guarantee every distribution policy. Google may still reject embedded/automated sign-in. Chromium app-bound encryption on Windows and KWallet cookie decryption are unsupported; Firefox or an explicitly connected personal browser are alternatives. The full unrelated server suite was not rerun for this browser-focused round.
