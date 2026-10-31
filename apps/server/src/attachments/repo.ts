import { randomBytes } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { AttachmentKind, AttachmentRef } from '@mingle/contracts';
import { nowIso } from '../util.ts';

type Row = Record<string, unknown>;
export type ScopeKind = 'session' | 'group';
export type OwnerKind = 'message' | 'group_message' | 'queued';
export type AttachmentStatus = 'draft' | 'sent' | 'deleted';

export interface AttachmentRow extends AttachmentRef {
  projectId: string; scopeKind: ScopeKind; scopeId: string; sha256: string; status: AttachmentStatus; sentAt: string | null;
}

export const attachmentId = (): string => `att_${randomBytes(16).toString('hex')}`;

const toRef = (r: Row): AttachmentRef => ({
  id: r.id as string, name: r.name as string, mimeType: r.mime_type as string, size: r.size as number, kind: r.kind as AttachmentKind, createdAt: r.created_at as string,
});
const toRow = (r: Row): AttachmentRow => ({
  ...toRef(r), projectId: r.project_id as string, scopeKind: r.scope_kind as ScopeKind, scopeId: r.scope_id as string, sha256: r.sha256 as string,
  status: r.status as AttachmentStatus, sentAt: (r.sent_at as string | null) ?? null,
});

/** Thin SQL layer; callers own transactions through Store.tx. */
export class AttachmentRepo {
  constructor(private readonly db: DatabaseSync) {}
  private all(sql: string, ...params: SQLInputValue[]): Row[] { return this.db.prepare(sql).all(...params) as Row[]; }
  private get(sql: string, ...params: SQLInputValue[]): Row | undefined { return this.db.prepare(sql).get(...params) as Row | undefined; }
  private run(sql: string, ...params: SQLInputValue[]): number { return Number(this.db.prepare(sql).run(...params).changes); }

  insert(input: { id: string; projectId: string; scopeKind: ScopeKind; scopeId: string; kind: AttachmentKind; name: string; mimeType: string; size: number; sha256: string }): AttachmentRow {
    this.run(`INSERT INTO attachments(id, project_id, scope_kind, scope_id, kind, name, mime_type, size, sha256, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`,
      input.id, input.projectId, input.scopeKind, input.scopeId, input.kind, input.name, input.mimeType, input.size, input.sha256, nowIso());
    return this.getRow(input.id)!;
  }
  getRow(id: string): AttachmentRow | undefined {
    const row = this.get("SELECT * FROM attachments WHERE id = ? AND status <> 'deleted'", id);
    return row ? toRow(row) : undefined;
  }
  rowsByIds(ids: readonly string[]): AttachmentRow[] {
    if (!ids.length) return [];
    return this.all(`SELECT * FROM attachments WHERE status <> 'deleted' AND id IN (${ids.map(() => '?').join(',')})`, ...ids).map(toRow);
  }
  drafts(scopeKind: ScopeKind, scopeId: string): AttachmentRow[] {
    return this.all("SELECT * FROM attachments WHERE scope_kind = ? AND scope_id = ? AND status = 'draft' ORDER BY created_at ASC", scopeKind, scopeId).map(toRow);
  }
  /** Marks a draft sent and links it to its message; false when it was already sent, deleted or removed concurrently. */
  link(id: string, ownerKind: OwnerKind, ownerId: string, position: number): boolean {
    if (this.run("UPDATE attachments SET status = 'sent', sent_at = ? WHERE id = ? AND status = 'draft'", nowIso(), id) !== 1) return false;
    this.run('INSERT INTO attachment_links(attachment_id, owner_kind, owner_id, position) VALUES (?, ?, ?, ?)', id, ownerKind, ownerId, position);
    return true;
  }
  forOwner(ownerKind: OwnerKind, ownerId: string): AttachmentRow[] {
    return this.all(
      `SELECT a.* FROM attachments a JOIN attachment_links l ON l.attachment_id = a.id WHERE l.owner_kind = ? AND l.owner_id = ? AND a.status = 'sent' ORDER BY l.position ASC`,
      ownerKind, ownerId,
    ).map(toRow);
  }
  transferOwner(fromKind: OwnerKind, fromId: string, toKind: OwnerKind, toId: string): void {
    this.run('UPDATE attachment_links SET owner_kind = ?, owner_id = ? WHERE owner_kind = ? AND owner_id = ?', toKind, toId, fromKind, fromId);
  }
  deleteOwner(ownerKind: OwnerKind, ownerId: string): string[] {
    const ids = this.all('SELECT attachment_id FROM attachment_links WHERE owner_kind = ? AND owner_id = ?', ownerKind, ownerId).map((row) => row.attachment_id as string);
    this.run('DELETE FROM attachment_links WHERE owner_kind = ? AND owner_id = ?', ownerKind, ownerId);
    return ids;
  }
  markOwnerDeleted(ownerKind: OwnerKind, ownerId: string): string[] {
    const ids = this.all('SELECT attachment_id FROM attachment_links WHERE owner_kind = ? AND owner_id = ?', ownerKind, ownerId).map((row) => row.attachment_id as string);
    if (ids.length) this.run(`UPDATE attachments SET status = 'deleted', deleted_at = ? WHERE id IN (${ids.map(() => '?').join(',')}) AND status = 'sent'`, nowIso(), ...ids);
    this.run('DELETE FROM attachment_links WHERE owner_kind = ? AND owner_id = ?', ownerKind, ownerId);
    return ids;
  }
  /** Metadata for many owners at once, grouped by owner id. */
  refsForOwners(ownerKind: OwnerKind, ownerIds: readonly string[]): Map<string, AttachmentRef[]> {
    const out = new Map<string, AttachmentRef[]>();
    for (let i = 0; i < ownerIds.length; i += 400) {
      const chunk = ownerIds.slice(i, i + 400);
      const rows = this.all(
        `SELECT a.*, l.owner_id AS owner_id FROM attachments a JOIN attachment_links l ON l.attachment_id = a.id
         WHERE l.owner_kind = ? AND l.owner_id IN (${chunk.map(() => '?').join(',')}) AND a.status = 'sent' ORDER BY l.owner_id, l.position ASC`,
        ownerKind, ...chunk,
      );
      for (const row of rows) {
        const list = out.get(row.owner_id as string) ?? [];
        list.push(toRef(row));
        out.set(row.owner_id as string, list);
      }
    }
    return out;
  }
  markDeleted(id: string): boolean {
    return this.run("UPDATE attachments SET status = 'deleted', deleted_at = ? WHERE id = ? AND status = 'draft'", nowIso(), id) === 1;
  }
  staleDrafts(olderThanIso: string, limit: number): AttachmentRow[] {
    return this.all("SELECT * FROM attachments WHERE status = 'draft' AND created_at < ? ORDER BY created_at ASC LIMIT ?", olderThanIso, limit).map(toRow);
  }
  deletedIds(limit: number): string[] {
    return this.all("SELECT id FROM attachments WHERE status = 'deleted' LIMIT ?", limit).map((row) => row.id as string);
  }
  purge(id: string): void {
    this.run('DELETE FROM attachments WHERE id = ? AND status = ?', id, 'deleted');
  }
  isStored(id: string): boolean { return Boolean(this.get("SELECT 1 AS x FROM attachments WHERE id = ? AND status <> 'deleted'", id)); }
  /** True when a visible, non-archived scope owns the attachment. */
  scopeVisible(scopeKind: ScopeKind, scopeId: string): { projectId: string } | null {
    const row = scopeKind === 'session'
      ? this.get(`SELECT s.project_id AS project_id FROM sessions s JOIN projects p ON p.id = s.project_id WHERE s.id = ? AND s.archived_at IS NULL AND p.archived_at IS NULL`, scopeId)
      : this.get(`SELECT g.project_id AS project_id FROM conversation_groups g JOIN projects p ON p.id = g.project_id JOIN sessions s ON s.id = g.anchor_session_id
                  WHERE g.id = ? AND p.archived_at IS NULL AND s.archived_at IS NULL`, scopeId);
    return row ? { projectId: row.project_id as string } : null;
  }
}
