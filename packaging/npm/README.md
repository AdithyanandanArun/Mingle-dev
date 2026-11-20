# Mingle desktop installer

Use npm to install the native Mingle desktop app. The installer fetches the exact desktop release that matches this package version from Mingle's GitHub releases and checks its size and SHA-256 before opening it. npm installation itself only installs the command.

```sh
npx @mingedevteam/mingle install
```

For a global command:

```sh
npm install -g @mingedevteam/mingle
mingle-install install
```

The installer targets Windows x64, Intel and Apple Silicon macOS, and x64 Debian/Ubuntu and Arch Linux families. Windows and macOS use their native installer UI. On Linux, confirm the installation in your package manager when prompted. Use `mingle-install install --download-only` to save and verify the native installer without opening it. Mingle runtime data is managed by the installed desktop application.

## Maintainers

After building native installers and their SHA-256 sidecars, run `node scripts/package-npm.mjs /path/to/release-assets` to stage the package. It requires the full matrix for the desktop version in the checkout. Run `npm pack /path/to/npm-stage-...` and test that tarball on each target. The matching GitHub release must contain the same assets before npm publication. macOS requires the separate native build, signing, and notarization flow.
