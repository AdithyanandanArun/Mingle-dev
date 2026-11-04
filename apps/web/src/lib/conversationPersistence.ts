/** Small, validated browser-local cache for standalone drafts and reader positions. */
export const CONVERSATION_CACHE_KEY = 'mingle:conversation-cache:v1';
export const MAX_CACHED_SESSIONS = 32;
export const MAX_DRAFT_CHARS = 20_000;
const MAX_TOTAL_DRAFT_CHARS = 120_000;
const MAX_TOTAL_DRAFT_BYTES = 480_000;
const MAX_SERIALIZED_CACHE_CHARS = 800_000;

function textBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export interface SavedReaderPosition {
  pinned: boolean;
  messageId?: string;
  runId?: string;
  offset?: number;
}
interface SavedSession {
  draft?: string;
  reader?: SavedReaderPosition;
  touchedAt: number;
}
interface Cache { version: 1; sessions: Record<string, SavedSession> }
export interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }

function validPosition(value: unknown): value is SavedReaderPosition {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.pinned === 'boolean'
    && (item.messageId === undefined || typeof item.messageId === 'string' && item.messageId.length <= 200)
    && (item.runId === undefined || typeof item.runId === 'string' && item.runId.length <= 200)
    && (item.offset === undefined || typeof item.offset === 'number' && Number.isFinite(item.offset) && Math.abs(item.offset) <= 100_000);
}

function read(storage: StorageLike): Cache {
  try {
    const raw = storage.getItem(CONVERSATION_CACHE_KEY);
    if (!raw || raw.length > MAX_SERIALIZED_CACHE_CHARS) return { version: 1, sessions: {} };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || (parsed as Cache).version !== 1 || !(parsed as Cache).sessions || typeof (parsed as Cache).sessions !== 'object') return { version: 1, sessions: {} };
    const candidates: Array<[string, SavedSession]> = [];
    for (const [id, candidate] of Object.entries((parsed as Cache).sessions)) {
      if (!id || id.length > 200 || !candidate || typeof candidate !== 'object') continue;
      const row = candidate as SavedSession;
      const draft = typeof row.draft === 'string' ? row.draft.slice(0, MAX_DRAFT_CHARS) : undefined;
      const reader = validPosition(row.reader) ? row.reader : undefined;
      candidates.push([id, { ...(draft ? { draft } : {}), ...(reader ? { reader } : {}), touchedAt: Number.isFinite(row.touchedAt) ? row.touchedAt : 0 }]);
    }
    const sessions: Record<string, SavedSession> = {};
    let total = 0;
    let totalBytes = 0;
    for (const [id, row] of candidates.sort((a, b) => b[1].touchedAt - a[1].touchedAt).slice(0, MAX_CACHED_SESSIONS)) {
      const bytes = row.draft ? textBytes(row.draft) : 0;
      if (row.draft && (total + row.draft.length > MAX_TOTAL_DRAFT_CHARS || totalBytes + bytes > MAX_TOTAL_DRAFT_BYTES)) row.draft = undefined;
      if (row.draft) { total += row.draft.length; totalBytes += bytes; }
      sessions[id] = row;
    }
    return { version: 1, sessions };
  } catch { return { version: 1, sessions: {} }; }
}

function write(storage: StorageLike, cache: Cache): void {
  const rows = Object.entries(cache.sessions).sort((a, b) => b[1].touchedAt - a[1].touchedAt).slice(0, MAX_CACHED_SESSIONS);
  let total = 0;
  let totalBytes = 0;
  const sessions: Cache['sessions'] = {};
  for (const [id, row] of rows) {
    const draft = row.draft?.slice(0, MAX_DRAFT_CHARS);
    const bytes = draft ? textBytes(draft) : 0;
    if (draft && (total + draft.length > MAX_TOTAL_DRAFT_CHARS || totalBytes + bytes > MAX_TOTAL_DRAFT_BYTES)) continue;
    if (draft) { total += draft.length; totalBytes += bytes; }
    sessions[id] = { ...(draft ? { draft } : {}), ...(row.reader ? { reader: row.reader } : {}), touchedAt: row.touchedAt };
  }
  storage.setItem(CONVERSATION_CACHE_KEY, JSON.stringify({ version: 1, sessions } satisfies Cache));
}

function update(storage: StorageLike, sessionId: string, change: (row: SavedSession) => SavedSession): void {
  if (!sessionId || sessionId.length > 200) return;
  const cache = read(storage);
  cache.sessions[sessionId] = change(cache.sessions[sessionId] ?? { touchedAt: Date.now() });
  write(storage, cache);
}

export function loadDraft(sessionId: string, storage: StorageLike = localStorage): string | null {
  return read(storage).sessions[sessionId]?.draft ?? null;
}
export function saveDraft(sessionId: string, draft: string, storage: StorageLike = localStorage): void {
  update(storage, sessionId, (row) => ({ ...row, ...(draft ? { draft: draft.slice(0, MAX_DRAFT_CHARS) } : { draft: undefined }), touchedAt: Date.now() }));
}
export function clearDraftIfMatches(sessionId: string, expected: string, storage: StorageLike = localStorage): void {
  update(storage, sessionId, (row) => row.draft === expected ? { ...row, draft: undefined, touchedAt: Date.now() } : row);
}
export function loadReaderPosition(sessionId: string, storage: StorageLike = localStorage): SavedReaderPosition | null {
  return read(storage).sessions[sessionId]?.reader ?? null;
}
export function saveReaderPosition(sessionId: string, reader: SavedReaderPosition, storage: StorageLike = localStorage): void {
  if (!validPosition(reader)) return;
  update(storage, sessionId, (row) => ({ ...row, reader, touchedAt: Date.now() }));
}
