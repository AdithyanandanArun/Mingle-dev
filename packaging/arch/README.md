# Arch Linux package

`PKGBUILD` packages the x86_64 Linux release as `mingle-bin`. It uses the bundled Electron and Node runtimes; it does not depend on the system `electron` or `nodejs` packages. The package provides, conflicts with, and replaces the former `relay-workspace-bin` package.

For a local release build, copy the release archive beside `PKGBUILD`, then build the package:

```sh
cp ../../release/mingle-0.0.2-linux-x64.tar.gz .
makepkg -s
sudo pacman -U ./mingle-bin-0.0.2-1-x86_64.pkg.tar.zst
```

The archive's SHA-256 must match the checksum in `PKGBUILD`. For an upstream release build, makepkg downloads that same archive from the GitHub release URL instead.

This recipe is not registered on the AUR. After maintainers publish and register it there, users may install it with `yay -S mingle-bin`. Until then, use the local `makepkg` and `pacman -U` steps above. Existing pre-rename archives and packages keep their original `relay-workspace-*` filenames.


From the repository root, `pnpm package:arch` builds both the desktop archive and the installable Arch package, regenerating the archive checksum in `release/arch-build/PKGBUILD` automatically. It needs Arch's `base-devel` tools and must run as an ordinary user. For an AUR release, copy that generated recipe and run `makepkg --printsrcinfo > .SRCINFO` before publishing; never use a checksum from a different archive/build.

The repository's recipe and `.SRCINFO` describe the Mingle 0.0.2 package target; the source checksum is refreshed from the built archive by `pnpm package:arch`. The corresponding GitHub release URL is not live until the owner publishes that artifact. Mingle's license is still unspecified and must be resolved before publication.
