export interface DiffLine { kind: 'add' | 'del' | 'ctx' | 'hunk' | 'meta'; text: string; oldNo?: number; newNo?: number }
export interface DiffFile { path: string; lines: DiffLine[]; adds: number; dels: number; binary: boolean }

/** Parses unified `git diff` output into per-file blocks with line numbers. */
export function parseDiff(diff: string): DiffFile[] {
  if (!diff.trim()) return [];
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      // Git quotes paths containing whitespace, tabs or control characters. The file
      // summary is authoritative for the displayed path; this parser still needs a
      // useful fallback when handed a standalone patch.
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw);
      cur = { path: m?.[2] ?? raw.slice(11), lines: [], adds: 0, dels: 0, binary: false };
      files.push(cur);
      inHunk = false;
      continue;
    }
    if (!cur) continue;
    if (raw.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
      oldNo = m ? Number(m[1]) : 0;
      newNo = m ? Number(m[3]) : 0;
      inHunk = true;
      cur.lines.push({ kind: 'hunk', text: raw });
      continue;
    }
    if (!inHunk) {
      if (raw.startsWith('Binary files')) { cur.binary = true; cur.lines.push({ kind: 'meta', text: raw }); }
      else if (/^(new file|deleted file|rename|similarity|old mode|new mode)/.test(raw)) cur.lines.push({ kind: 'meta', text: raw });
      continue;
    }
    if (raw.startsWith('+')) { cur.adds++; cur.lines.push({ kind: 'add', text: raw.slice(1), newNo: newNo++ }); }
    else if (raw.startsWith('-')) { cur.dels++; cur.lines.push({ kind: 'del', text: raw.slice(1), oldNo: oldNo++ }); }
    else if (raw.startsWith('\\')) cur.lines.push({ kind: 'meta', text: raw });
    else if (raw.startsWith(' ')) cur.lines.push({ kind: 'ctx', text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
    else { inHunk = false; }
  }
  return files;
}
