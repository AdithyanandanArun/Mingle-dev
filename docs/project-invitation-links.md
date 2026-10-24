# Desktop project-invitation links

Mingle desktop accepts project invitations through this exact link shape:

```text
mingle://join?token=<base64url-token>
```

The token is unpadded, canonical base64url with a length from 43 through 128 characters, matching `ProjectInvitationTokenSchema`. The desktop accepts the standard `mingle://join?token=…` form and common platform variants `mingle://join/?token=…` and `mingle:join?token=…` (also with a trailing slash after `join`). It rejects other schemes or targets, credentials, ports, extra paths, fragments, control characters, duplicate query keys, extra parameters, invalid base64url and oversized links. It never logs the invitation value.

The Electron main process receives cold-launch links from `process.argv`, later launches from Electron's `second-instance` event, and macOS links from `open-url`. The existing single-instance lock remains in force. The first cold-start link is handed off in the initial `/?join=<encoded-token>` URL. Later links are sent over a dedicated main-to-preload IPC channel after the workspace is ready; they do not reload or navigate the window. The sandboxed preload queues at most 16 unique pending tokens until a UI listener subscribes. Links do not navigate to external origins, execute code, select a checkout, start a provider run or accept an invitation automatically.

The renderer reads `join` from the initial URL for a cold launch and subscribes for warm links with `window.mingleProjectInvitations.onInvitation((token) => { ... })`. The method returns an unsubscribe function. It removes a cold-start token from browser history once captured and keeps tokens in memory only. Every new invite replaces an existing modal and displays its join dialog above all other overlays; hidden or minimized desktop windows are restored, shown and focused before delivery. The invitation UI remains responsible for presenting local checkout selection and initial-agent selection before any invitation is accepted or paid work begins.

Linux packages include `x-scheme-handler/mingle` in `mingle.desktop` and pass the single URL argument to the `mingle` launcher. Windows per-user installation registers `HKCU\Software\Classes\mingle` with a quoted `"mingle.exe" "%1"` command. Uninstall removes the protocol registration only while its open command still exactly matches that installation's executable. Packaged Linux/Windows apps may register through Electron; development launches do not claim the machine-wide protocol handler.

Focused validation is available with:

```sh
node --check apps/desktop/main.mjs
node --check apps/desktop/project-invitation.mjs
node --check apps/desktop/browser-preload.cjs
node --test apps/desktop/project-invitation.test.mjs apps/desktop/browser-preload.test.cjs
```

These checks exercise parsing, bounded queuing, local-origin dispatch and focus restoration without modifying OS protocol settings. The Windows installer registers the URL command as `"mingle.exe" "%1"`, passing the full link as one argument. Native Linux desktop-handler and Windows registry activation were not exercised by these tests.
