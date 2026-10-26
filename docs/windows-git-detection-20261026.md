# Windows Git detection — 26 October 2026

Release source: `f4375246b85995418cd2a7bb348548bb2149f1d1` (Mingle 0.0.3).

The clone, repository inspection and shared-project join paths used three Git runners. They passed Node's native null-device spelling (`\\.\nul` on Windows) to Git config and diff arguments. Git for Windows has its own device-path handling; an inaccessible config path could make `rev-parse` fail on an intact clone. The join path then labeled every nonzero inspection result as “not an existing Git repository.”

All three runners now use the documented Git-compatible `/dev/null` spelling. Git for Windows maps this internally, while its config isolation, hook restrictions and ownership checks remain enabled. The compatibility behavior is documented in [Git for Windows issue 6449](https://github.com/git-for-windows/git/issues/6449). Join inspection now preserves scrubbed configuration diagnostics and distinguishes ownership rejection, bare repositories and genuine nonrepository folders. Existing intact clones remain usable.

## Verification

| Check | Evidence |
| --- | --- |
| Server suite | 395 passed across 53 files; one Windows-only test skipped on Ubuntu and covered by the native Windows run |
| Native Windows regressions | Six tests covering all Git runners, cloned/unborn/worktree repositories, Unicode/space paths, untracked diffs and real HTTP invitation preflight |
| Local focused tests | 13 passed, one Windows-only test skipped; server TypeScript and packaging-script syntax checks passed |
| Packaged Git check | Real local clone, linked worktree and ordinary folder checked through both Git HTTP views and the post-repository join boundary |
| Shared browser | Cloned the public Mingle repository through the actual Git URL dialog into “Example Café Clone”; both Git views returned true, the footer showed main and join reached sign-in; zero provider runs |

Native builds additionally run their existing runtime and installer checks before release publication. Their disposable repositories require no credentials or network and accept no invitation. The packaged check allows the two specific results from concurrent account/provider validation: signed out or the chosen provider being unavailable. Its first revision incorrectly required the sign-in failure to finish first; that test assumption was corrected without weakening repository assertions.

- [Source validation](https://github.com/AdithyanandanArun/Mingle-dev/actions/runs/40342575131)
- [Native Windows build and checks](https://github.com/AdithyanandanArun/Mingle-dev/actions/runs/40342606270)
- [Linux build and checks](https://github.com/AdithyanandanArun/Mingle-dev/actions/runs/40342613510)
- [0.0.3 downloads](https://github.com/AdithyanandanArun/Mingle-dev/releases/tag/v0.0.3)

The browser used a disposable Linux application with explicitly fake providers. Windows verification uses a native Windows CI runner; this is not a manual acceptance on the recipient's physical computer or a live Google invitation acceptance. No paid inference ran.
