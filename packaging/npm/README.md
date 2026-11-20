# Mingle desktop installer

Use npm to install the native Mingle desktop app. The installer fetches the exact desktop release that matches this package version from Mingle's GitHub releases and checks its size and SHA-256 before opening it. npm installation itself only installs the command.

```sh
npx @mingledev/mingle install
```

For a global command:

```sh
npm install -g @mingledev/mingle
mingle-install install
```

The first npm release supports Windows x64 and x64 Linux on Debian, Ubuntu, Arch and their derivatives. On Windows, follow the installer prompts. On Linux, confirm the installation in your package manager when prompted. Use `mingle-install install --download-only` to save and verify the native installer without opening it. Mingle runtime data is managed by the installed desktop application.

## Maintainers

Run `node scripts/package-npm.mjs /path/to/release-assets` to stage the package with the Debian, Arch, and Windows installers and their SHA-256 sidecars. Use the matching GitHub release for the desktop version in the checkout. Run `npm pack /path/to/npm-stage-...` and test the tarball on the supported targets before publishing.
