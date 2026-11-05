# Managed provider CLI installations

Provider update checks compare the installed stable version with the provider's public npm release. A CLI with a verified native self updater keeps that update path. Other supported installations can be updated through an explicit action that installs the exact checked package version into Mingle's user-local `provider-clis/<provider>/<version>` directory.

Managed installs never replace the existing CLI. Mingle validates that the versioned executable resolves inside its managed root, belongs to the current OS user, and reports the exact checked version before it changes the saved provider executable preference. Version directories are immutable: a later release gets a new directory. A failed or interrupted install leaves the existing preference in place. The original executable preference, including an empty preference for automatic discovery, is retained with the update record for restoration in Settings.

The install uses Node's discovered `npm-cli.js` with a fixed argument list, the public npm registry, and an exact package version. It does not use a shell, global package installation, elevated privileges, or provider authentication files. Updates hold the provider maintenance lease through installation and preference activation, so active turns and compaction block the operation.

The managed action is supported on Linux and macOS when a usable Node/npm CLI is available. Windows managed installs are currently withheld because npm's generated `.cmd` launchers cannot be invoked safely without a shell. Provider packages may have platform-specific availability; install errors remain visible and do not switch the active executable.
