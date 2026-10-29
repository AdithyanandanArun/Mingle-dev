# Desktop distribution

Mingle's Linux x86_64 desktop release is distributed as a versioned tarball. The Arch recipe in [`packaging/arch/PKGBUILD`](../packaging/arch/PKGBUILD) repackages that archive as `mingle-bin`, installing the app under `/opt/mingle`, a launcher in `/usr/bin`, the desktop entry, scalable icon and bundled license texts.

## Build artifacts

With development dependencies installed, `pnpm package:linux` builds the UI, downloads the pinned official Node runtime after SHA-256 verification, deploys production dependencies in an isolated temporary workspace, and compiles Mingle's server and contracts into JavaScript. It stages Electron and the runtime in `release/mingle-<version>-linux-x64` and creates the corresponding `.tar.gz` plus `.sha256` file. The release does not contain databases, credentials or session worktrees.

`pnpm package:arch` additionally invokes `makepkg` on Arch Linux as an ordinary user. It creates `release/mingle-bin-<version>-1-x86_64.pkg.tar.zst` and its checksum. The generated recipe in `release/arch-build/PKGBUILD` receives the exact archive checksum; the build does not install packages or request sudo. `makepkg --nodeps` is used for this repackaging step; install-time dependencies remain recorded in the package and are resolved by `pacman -U`.

`pnpm package:deb` builds the same Linux stage and uses `dpkg-deb` to create `release/mingle_<version>_amd64.deb` and its SHA-256 file. Run it on Debian/Ubuntu. It installs under `/opt/mingle`, with a desktop entry, icon, launcher and a root-owned sandbox helper. It declares system library dependencies and Git; it never modifies user profiles or starts a service. Install a downloaded package with `sudo apt install ./mingle_0.0.8_amd64.deb`.

The manual **Build desktop packages** GitHub workflow builds Linux on Ubuntu 22.04 and validates Debian extraction, native PTY operation, SQLite/server startup, HTTP/static assets, installation and removal in its disposable runner. Arch output is optional via `include_arch`; it verifies the input archive sidecar and resulting package metadata/checksum. Artifacts expire after seven days. The workflow does not create tags, public releases or AUR entries. The separate **Publish desktop release** workflow accepts `include_arch=true` to publish the Arch artifact from that same successful Linux build alongside the Debian, archive, and Windows assets.

## Windows

`pnpm package:windows` runs on Windows x64 and produces a per-user NSIS `.exe` installer and checksum. The separate manual Windows packaging workflow builds with native Windows dependencies and bundles the matching official Node runtime. Provider tools and their accounts remain separately installed. The installer is unsigned; Windows may show an unknown-publisher warning. GitHub prereleases used for temporary downloads are separate from stable releases and do not expire automatically.

## Arch Linux

For a locally staged release, copy the archive next to the recipe, build it with `makepkg`, then install the resulting package:

```sh
node scripts/package-arch.mjs
sudo pacman -U ./release/mingle-bin-0.0.8-1-x86_64.pkg.tar.zst
```

The command above assumes the current Linux archive and SHA-256 sidecar are already in `release/`; `pnpm package:arch` also builds that archive. `pacman -U` installs a local package file and resolves its declared runtime dependencies. For an already published binary, download the `.pkg.tar.zst` and its checksum from GitHub, verify the checksum, and install with `pacman -U`.

The package is **not currently registered on the AUR**, so `yay -S mingle-bin` is not available yet. That command applies only after an AUR package entry is published.

## Runtime requirements

The package bundles Electron 44.9.0, the official Node 26.8.2 runtime, Mingle's compiled server and the built web client. It therefore does not require system `electron` or `nodejs`. It does require the host's shared libraries used by Electron/Chromium and Node, including the split `libatomic`, `libgcc` and `libstdc++` packages ([Arch guidance](https://archlinux.org/todo/gcc-libs-deprecation/)); the direct Arch package dependencies are listed in the `PKGBUILD`. Git is a required dependency for session worktrees and version-control features.

The Chromium sandbox helper is installed root-owned with mode `4755`, as required by Electron's Linux sandbox arrangement. The package does not turn off the sandbox. Review the [Arch package dependency guidance](https://wiki.archlinux.org/title/Arch_package_guidelines#Package_dependencies) and [Electron notes](https://wiki.archlinux.org/title/Electron) when maintaining the dependency list.

## Temporary download verification — 2026-10-22

The [Debian build](https://github.com/AdithyanandanArun/Mingle-dev/actions/runs/39784288177) built source `2e559ab` on Ubuntu 22.04 and passed package metadata/ownership checks, extracted and installed Node/PTY/SQLite/API/static-UI checks, sandboxed Electron rendering under Xvfb, and removal preserving a user-data sentinel. No package was installed on the owner's host.

The [Windows build](https://github.com/AdithyanandanArun/Mingle-dev/actions/runs/39792501063) built source `6bad569` on Windows Server 2022. It passed bundled Node/SQLite/API/static-UI and native ConPTY checks, an isolated silent NSIS installation, launching the installed Electron executable and checking its rendered DOM, and uninstallation preserving a separate user-data sentinel. The NSIS executable is unsigned. Native PTY verification runs in a bounded child process because ConPTY cleanup handles can otherwise keep the packaging CLI alive after success.

Windows uses a hoisted production dependency tree to keep installed paths short; Linux retains its existing pnpm layout. The legacy pnpm deployment may resolve versions within manifest ranges, so the packaged `resources/licenses/dependencies.json` records the versions actually distributed. The official Node archives are independently pinned by SHA-256. No paid provider inference ran in these packaging checks.

The temporary prerelease includes `.deb`, `.exe` and their SHA-256 files. Before dispatching the manual publication workflow, use an account with publication permission to create its temporary tag at the Windows build's source commit and prepare a draft prerelease for that tag. The workflow verifies this binding, the prerelease state and the completed native build/upload checks, then checksums the downloaded artifacts inside GitHub. For a draft, it uploads the four assets, verifies their names, sizes and GitHub SHA-256 digests, and publishes with `latest=false`; its token does not create source tags or releases. Rerunning against an already published temporary prerelease verifies the same four assets against the native build artifacts without replacing them or editing the release. A mismatch fails the run. Runs for the same tag are serialized. Temporary releases do not expire automatically; remove the temporary release and its tag after the requested downloads are complete.

## License metadata

The repository does not currently declare a project license. The recipe records this as `unknown` and installs the license notices bundled in each release; it does not claim that those third-party notices license Mingle itself. Set the package license metadata only after the project owner selects and documents a project license. The build inventories both backend dependencies and bundled frontend dependencies and includes their license/notice files.


## Installed behavior and updates

The package installs a real desktop entry and the `mingle` command. The desktop process selects a free loopback port, starts its packaged backend, opens the workspace and shuts the backend down when the app exits. The renderer retains context isolation and Chromium sandboxing. A fresh install stores data in `appData/Mingle/workspace`; if initialized legacy state exists, it selects `appData/Relay/workspace` in place and keeps Electron's user-data root there. Existing absolute worktree and profile paths are preserved. See [Mingle rename and data continuity](mingle-rename.md).

Claude Code and Codex remain separately installed provider tools. The optional SDK-bundled native Claude executable is excluded from the release; Mingle keeps its JavaScript Agent SDK adapter and discovers the user's installed CLI/login normally. No provider calls run during a package build.

The previous installed app may have created its database and browser profile under `appData/Relay`; the rebranded desktop selects this root in place when it contains initialized workspace data. It does not copy or rewrite it. Package upgrades replace application files while retaining user data; removing the package likewise leaves that user data for the owner to manage.

There is no automatic updater. Until an AUR listing exists, install newer package files with `pacman -U`; after publication, an AUR helper can rebuild/install new versions. The package is currently unsigned; signing and a package repository are separate release work.

## Publishing checklist

1. Select and document Mingle's project license; replace `unknown` metadata. Third-party license notices do not grant rights to Mingle itself.
2. Build the intended version and perform installation/launch verification on Arch. Type checking and package creation do not substitute for that check.
3. Review the generated archive/package checksums. Copy the generated recipe into the AUR publication checkout, regenerate `.SRCINFO`, and ensure its source URL names the exact release asset.
4. With the owner's approval, publish the versioned archive/package and checksums as a GitHub release, then register/update `mingle-bin` on the AUR using the owner's AUR account.

A GitHub repository or local `PKGBUILD` alone does not make the package available through `yay`. `pacman -S` would require inclusion in a configured package repository; the supported local-file command is `pacman -U` ([ArchWiki](https://wiki.archlinux.org/title/Arch_User_Repository)).
