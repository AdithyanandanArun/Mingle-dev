# Settings → Usage browser fixture

Run `node scripts/settings-usage-browser-acceptance.mjs` from the repository root. It starts the existing Vite web app with the repository's installed Playwright/Chromium dependencies and writes 390 px and 900 px screenshots to a temporary directory.

The fixture renders the real `SettingsPage` and `UsageSettings` components, with an empty example workspace, synthetic Codex and Claude provider metadata, and mocked `/api/bootstrap` and `/api/providers/*/usage` responses. It does not contact a provider, call a model, access cloud services, modify host settings, or invoke a real reset.

The acceptance checks cover page entry and no-request behavior in General, independent initial reads, reported and unknown windows, out-of-range percentages, partial and unavailable usage, reset grant expiry, confirmation cancellation and keyboard Escape, a double-click redemption fence, uncertain same-ID retries, fresh-read failure, stale-snapshot conflict handling, safe Claude navigation, no idle polling, reduced motion, narrow layout, and ignoring a pending read after the Usage category unmounts. The static fixture HTML is only an entry point; the harness exercises the production components.
