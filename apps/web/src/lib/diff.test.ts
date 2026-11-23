import { describe, expect, it } from 'vitest';
import { parseDiff } from './diff';

describe('parseDiff', () => {
  it('tracks omitted hunk lengths and line numbers for zero length additions', () => {
    const files = parseDiff('diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -0,0 +1 @@\n+first\n');
    expect(files[0]).toMatchObject({ path: 'a.txt', adds: 1, dels: 0 });
    expect(files[0]?.lines.at(-1)).toMatchObject({ kind: 'add', text: 'first', newNo: 1 });
  });

  it('does not treat malformed non-diff text in a hunk as a context line', () => {
    const files = parseDiff('diff --git a/a b/a\n@@ -1 +1 @@\n old\n+new\nnot patch text\n');
    expect(files[0]?.lines.map(line => line.kind)).toEqual(['hunk', 'ctx', 'add']);
    expect(files[0]?.adds).toBe(1);
  });

  it('recognizes binary patches and multiple file boundaries', () => {
    const files = parseDiff('diff --git a/a b/a\nBinary files a/a and b/a differ\ndiff --git a/b b/b\n@@ -1 +1 @@\n-x\n+y');
    expect(files).toHaveLength(2);
    expect(files[0]?.binary).toBe(true);
    expect(files[1]).toMatchObject({ path: 'b', adds: 1, dels: 1 });
  });
});
