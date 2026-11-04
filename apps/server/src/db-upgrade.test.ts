import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, SCHEMA_VERSION } from './db.ts';

describe('one-turn memory scope upgrades', () => {
  // v30 is the released v0.1.0 schema; an unreleased v32 could skip the misplaced migrations.
  it.each([30, 32])('upgrades schema v%i without losing existing provider preferences', (version) => {
    const directory = mkdtempSync(join(tmpdir(), 'mingle-context-upgrade-'));
    const file = join(directory, 'state.sqlite');
    try {
      const before = openDatabase(file);
      before.prepare('INSERT INTO provider_update_dismissals(provider,version,dismissed_at) VALUES(?,?,?)')
        .run('codex', 'example-version', '2026-11-04T00:00:00.000Z');
      // Retain the released tables and data while removing precisely the additive context scope objects.
      before.exec(`ALTER TABLE queued_messages DROP COLUMN memory_mode;
        DROP TABLE run_context_scopes;
        PRAGMA user_version = ${version};`);
      before.close();

      const upgraded = openDatabase(file);
      try {
        expect(upgraded.prepare('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION });
        const columns = upgraded.prepare('PRAGMA table_info(queued_messages)').all() as { name: string; dflt_value: string | null }[];
        expect(columns.find((column) => column.name === 'memory_mode')?.dflt_value).toBe("'include'");
        expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE name='run_context_scopes'").get()).toBeDefined();
        expect(upgraded.prepare('SELECT provider,version FROM provider_update_dismissals').all())
          .toEqual([{ provider: 'codex', version: 'example-version' }]);
        expect(upgraded.prepare('PRAGMA table_info(sessions)').all()).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'parent_session_id' })]));
        expect(upgraded.prepare('PRAGMA table_info(conversation_groups)').all()).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'preferred_coordinator_member_id' })]));
      } finally { upgraded.close(); }

      // A second open is idempotent and keeps the same schema version.
      const reopened = openDatabase(file);
      try { expect(reopened.prepare('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION }); }
      finally { reopened.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
