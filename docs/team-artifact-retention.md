# Team delivery artifact retention

Owner-device team deliveries run in a fresh Git worktree below the configured runtime-data `team-worktrees` directory. The shared-project and delivery directory names are stable hashes. Before Git creates the worktree, the durable delivery record stores its intended path, branch, and base revision, so a process crash during worktree creation still leaves a recovery pointer.

Delivery worktrees and their `mingle/team-agent/...` branches are retained indefinitely, including after successful transfer, failure, interruption, or restart recovery. Mingle does not prune them on a timer, when a delivery reaches a terminal status, or when the team session is removed. A crash may leave provider-created edits, commits not yet transferred, or an uncertain transfer result; keeping the checkout and branch preserves that evidence for review.

Cleanup is an explicit owner action after reviewing the delivery record, worktree status, branch history, and artifact transfer state. Use ordinary Git worktree and branch operations without force-removing dirty work. Do not delete an unexported or uncertain result merely because its delivery is terminal. The host's isolated imported refs and user-created branches are separate and are not cleaned up by owner-device worktree retention.

Embedding/test configurations that omit the runtime-data root use the durable private `$HOME/.mingle/team-worktrees` fallback. This keeps deliveries outside the project source even when the contributed session itself is nonisolated. Production wiring should provide `deliveryWorktreeRoot` under Mingle's configured runtime-data directory.
