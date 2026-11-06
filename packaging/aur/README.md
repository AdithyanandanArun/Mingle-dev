# Stable Mingle on the AUR

`mingle-dev/PKGBUILD` packages the published stable Linux x86_64 binary. It does not build from `main`, check for releases at launch, or replace application files outside pacman. Once the recipe is published on the AUR, install with `yay -S mingle-dev` and update with the normal `yay -Syu` flow. These commands do not discover this recipe until AUR publication succeeds.

The first recipe pins public v0.1.3 and its published archive checksum. Local builds after that release are not included. The existing `packaging/arch/PKGBUILD` and release workflow still produce `mingle-bin` GitHub assets; that is separate from this AUR package name. The packages conflict because both own `/opt/mingle`, `/usr/bin/mingle` and the same desktop entry. Package upgrades/removal retain the application's user data. Provider CLIs and logins remain separately installed; `github-cli` is optional.

## Validate

Run as an ordinary user on Arch with `base-devel` installed, in a disposable directory:

```sh
cp packaging/aur/mingle-dev/{PKGBUILD,.SRCINFO} /path/to/scratch/
cd /path/to/scratch
bash -n PKGBUILD
makepkg --printsrcinfo | diff - .SRCINFO
makepkg --verifysource
makepkg --cleanbuild
pacman -Qip ./mingle-dev-*.pkg.tar.zst
```

`makepkg` downloads the pinned archive and validates its SHA-256. It does not install the package unless explicitly requested. Never test package installation on a computer with an active Mingle session; use a disposable Arch environment for installation/removal checks. The packaged Chromium sandbox helper must remain root-owned with mode 4755 after installation.

## Publish

AUR publication needs the owner's AUR account and a registered SSH public key. There is no separate upload to yay: yay discovers recipes from the AUR. Do not commit private keys or account credentials here.

```sh
git clone ssh://aur@aur.archlinux.org/mingle-dev.git /path/to/aur-mingle-dev
cp packaging/aur/mingle-dev/{PKGBUILD,.SRCINFO} /path/to/aur-mingle-dev/
cd /path/to/aur-mingle-dev
git add PKGBUILD .SRCINFO
git commit -m 'Publish mingle-dev 0.1.3'
git push origin master
```

Use the repository owner's configured Git identity, with no assistant attribution. Follow AUR's current published SSH host-key instructions when establishing trust. After pushing, verify the package page and the AUR RPC info result before claiming `yay -S mingle-dev` works.

For each later stable release, change `pkgver`, reset `pkgrel` to 1, verify the published archive and checksum, regenerate `.SRCINFO` with `makepkg --printsrcinfo`, repeat validation, and publish the two files. Changes to the recipe for the same upstream version increment `pkgrel`. Automatic AUR publication is not configured by this recipe.

AUR account registration was temporarily closed when this package was prepared on 2026-11-06. The shared browser registration page stated there was no manual registration queue. Publication requires an existing owner-controlled account or registration reopening; do not script registration retries.

## Preparation checks (2026-11-06)

The AUR RPC reported no existing `mingle-dev` entry. The pinned SHA-256 matched both the public GitHub asset digest and its downloaded checksum sidecar. Bash syntax and an exact regenerated `.SRCINFO` comparison passed. A disposable Arch `makepkg` build using the current local 0.1.3 archive and its own checksum passed; that local build is **not** the published archive named by the tracked recipe. Its package metadata, conflicts, executable launcher, bundled license, sandbox mode and desktop entry were checked. The extracted bundled Node/PTY/SQLite/API/UI smoke check passed without installing the package or starting providers. Full published-archive download/build and native installed GUI checks remain pending. Nothing was published to AUR, and no host installation was changed.
