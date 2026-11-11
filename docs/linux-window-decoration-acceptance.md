# Linux system title bar

Source verification on 2026-11-11. This change makes the system title bar optional in the Linux desktop application; it does not update the installed app.

## Behavior

- Appearance shows **System title bar → Show (default) / Hide** only in the Linux desktop main workspace. Desktop environments that need the native controls keep them by default. Hiding is intended for window managers that already provide movement, resizing and closing.
- The setting is device-local, saved atomically in Electron user-data as `window-decoration.json` with private file permissions. It is separate from SQLite and account preference sync. Missing, malformed and oversized files fall back to the system bar.
- The main window and Mingle browser popouts use the startup choice. A saved change asks the user to quit and reopen; it never restarts running sessions automatically. Selecting Show restores the frame on the next launch.
- Fixed IPC calls accept only `system` and `hidden`. The main process checks the main workspace sender, top-level frame and workspace URL. Guest frames and unrelated windows cannot read or change the preference. Filesystem errors return a generic save failure.
- The packager includes both new runtime modules; CI includes the preference and IPC tests.

## Checks run

- `pnpm typecheck`: passed across contracts, desktop, server and web (invoked through npm with pnpm 11.26.0).
- `pnpm build`: passed web production build and server typecheck.
- `node --test apps/desktop/*.test.mjs apps/desktop/browser-preload.test.cjs apps/desktop/embedded-browser/*.test.mjs`: 37 passed, including preference persistence, startup frame options, failed writes, IPC authorization, preload validation, invitation handling and browser relay checks.
- `node scripts/appearance-browser-acceptance.mjs`: passed monochrome appearance and Example desktop-bridge cases for Linux defaults, persistence, restore, load/save failures, browser/non-Linux gating and 390px layout. The narrow-layout screenshot was inspected.
- Syntax checks for the changed desktop/packaging scripts and `git diff --check`: passed.

## Limits

Browser checks use an explicitly labelled Example fixture with a desktop bridge stand-in. They do not launch Electron or verify compositor behavior. No provider inference or cloud work is part of these checks. Real X11/Wayland window decoration, movement, resizing and close behavior across Linux window managers, and native package installation, remain manual checks.
