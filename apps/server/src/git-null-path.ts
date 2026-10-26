/**
 * Git-specific null device path. Git for Windows maps `/dev/null` to `NUL`;
 * do not use Node's `os.devNull` spelling, which Git for Windows 2.56 UCRT
 * rejects in config-file paths (git-for-windows/git#6449).
 */
export function gitNullPath(): string {
  return '/dev/null';
}
