# Shared browser

Mingle's shared browser lets you and agents operate the same page. The desktop app can display sandboxed Chromium directly inside Mingle; the web shell uses a WebSocket screencast. The Node server owns agent actions separately from the UI. This implementation is original; T3 Code is an architectural and UX reference, without copied implementation or a dependency on it.

## Use it

Open a session, show the context pane, then select **Browser**. Choose one of:

- **Built-in browser (desktop):** uses Electron's own sandboxed Chromium in an isolated, persistent partition for the session. No second Chromium download is required. The page accepts your keyboard and mouse directly. Main-window, floating, full-view and popout presentations share the same tabs; overlapping Mingle menus use a streamed fallback.
- **Mingle-managed Chromium:** a separately installed browser with its own persistent profile for the session. Install the pinned browser from the pane or **Settings → Browser**, or configure an absolute executable path. It starts without your personal browser's logins.
- **Your running browser:** share existing logins and open web tabs by connecting to a running Chromium browser. Enable remote debugging in that browser, select the detected browser or enter its loopback CDP endpoint, and explicitly connect. An agent cannot attach to a personal browser by itself.

New installations prefer the built-in option. Settings → Browser lets you change the default; an already saved choice is preserved. Automatic tab opening honors this preference. In a web-only runtime without an Electron host, the built-in preference falls back to managed Chromium. Attaching to your personal running browser always requires an explicit connection.

For Chrome 144 or newer, open `chrome://inspect/#remote-debugging`, enable remote debugging and approve Chrome's connection prompt. Availability varies among Chromium derivatives and versions. Browsers that do not provide that consent flow need an already configured loopback CDP endpoint. Chrome 136+ refuses the old debugging-port approach with its default user-data directory; Mingle does not relaunch or modify that profile to work around it. See [Chrome's auto-connect documentation](https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect) and [debugging-port change](https://developer.chrome.com/blog/remote-debugging-port).

A connection to a running browser shares its web tabs and logged-in session without copying them. Disconnect leaves that browser open. Closing a shared tab closes the actual tab; the UI asks before closing a tab in an attached personal browser.

Click, type or scroll to step in immediately. A short touch lease renews while you interact and returns control about 2.5 seconds after activity stops. **Keep control** pins the lease until **Hand back to agent**. Watching alone does not take control. Agent inspection remains available while you drive; writes receive a clear retry/handoff message. Keyboard input is captured only while the page is focused. Alt+Shift+Esc returns focus to Mingle. Paste forwards text you explicitly paste, without automatically reading the system clipboard.

## Ubuntu sandbox and sign-ins

The built-in browser uses the sandbox already available to the running desktop app. It avoids the additional Playwright Chromium installation that AppArmor may block on Ubuntu. It does not disable Electron or Chromium sandboxing, and it cannot promise compatibility with every distribution's security policy.

For the separate managed browser, Mingle reports Linux user-namespace restrictions and offers an explicit administrator-authorized AppArmor profile for the selected Chromium path, when supported. You can inspect the proposed commands or use an installed compatible browser instead. No global AppArmor policy is disabled automatically. The real Ubuntu administrator flow still needs device acceptance; local tests simulate its detection and profile generation.

Google and other sites may refuse embedded or automated browsers. **Use my sign-ins…** explicitly imports selected sites' cookies from a chosen local profile into the Mingle session. Sites include their subdomains; this grants agents access to those signed-in sites, so import only what you intend to share. The browser connection alone does not import anything. Cookie values never enter API responses or logs; temporary database copies are private and removed after use. Reload the site after import. No passwords or complete profiles are copied.

Firefox cookie import is supported. Chromium import supports known Linux and macOS formats; Linux encrypted cookies may require `secret-tool`, and macOS may ask for Keychain access. KWallet and Windows Chromium app-bound encryption are unsupported; the UI reports those limitations. A separate managed sign-in window is available, but it cannot guarantee Google accepts a login. No live Google account was used for automated acceptance.

## Agent access

Both Codex and Claude Code receive a local HTTP MCP connection on each enabled run. It provides status, tabs, open, snapshot, navigate, click, type, hover, select, press, scroll, resize, evaluate, wait, dialog, back, forward, reload and close tools. A snapshot includes bounded visible text, tab- and snapshot-scoped accessibility targets and an optional PNG. Textbox values are hidden; navigation or another snapshot invalidates old refs. Tools should begin with status and use fresh snapshot refs or role/name targets.

**Settings → Browser → Let agents use the browser** controls this access. Supervised and Auto-accept edits sessions require approval before the run's first browser mutation; Auto and Full access follow their selected policy. The browser is capable of actions in signed-in accounts, so those actions must follow the user's task and authorization.

Connections use ephemeral random bearer capabilities stored hashed in memory, bound to a run and session, and revoked when the run ends. They are not exposed through bootstrap or settings, and are scrubbed from provider events before persistence. Tabs are scoped to a Mingle session. Streaming has bounded viewers, input queues, buffers and acknowledgement pacing. Human/agent handoffs invalidate queued writes from the old owner.

## Context compaction

**Settings → General → Context** selects a native default or an integer threshold from 1–95%. It applies to subsequent runs, including resumed conversations, through native provider controls. Claude receives its documented percentage environment override. Codex receives an absolute token limit calculated from its reported/configured model capacity. Unknown capacity leaves native compaction enabled and produces a notice; Mingle never guesses a model's window. Providers may compact earlier because of their own limits and reserved context. See [the provider mapping and observed limits](provider-compaction-research.md).

## Scope and platform limits

The desktop native view and web screencast share the server's action and ownership model. Discovery includes Linux, macOS and Windows locations, but native acceptance was exercised on Arch Linux; Ubuntu/AppArmor, Windows and macOS still need device verification. Playwright's [CDP connection](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp) supports Chromium only and has lower fidelity than its native transport.

This first version does not add file uploads, download management, recording, browser extension management, or profile copying. Browser-internal pages and file URLs are excluded from navigation. Native browser permission prompts still need the user. Page JavaScript that starts timers or promises cannot have its earlier side effects undone; timed-out evaluations report that limitation. Synchronous scripts have an execution deadline and termination handling, without closing personal tabs. Closing Mingle closes its managed browser; attached personal browsers are detached. The session's dedicated managed profile remains on disk.

## Research references

- [T3 Code repository](https://github.com/pingdotgg/t3code), researched at `f740a97`: server preview/MCP services and Electron CDP relay.
- [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp), `BrowserManager.ts`: consent-enabled Chrome discovery uses the selected browser's `DevToolsActivePort` metadata. Mingle implements its own bounded parser.
- [Chrome DevTools screencast protocol](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-startScreencast).
- [Playwright browser lifecycle](https://playwright.dev/docs/api/class-browser#browser-close): closing a connected browser disconnects it; closing a launched browser quits it.

See [shared-browser acceptance](shared-browser-acceptance.md) for the local checks and native-device validation limits.
