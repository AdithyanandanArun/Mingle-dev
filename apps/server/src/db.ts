import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync } from 'node:fs';

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((row) => row.name === column);
}

function addColumn(db: DatabaseSync, table: string, column: string, statement: string): void {
  if (!hasColumn(db, table, column)) db.exec(statement);
}

function ensurePlanTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS session_plans (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT NOT NULL REFERENCES session_runs(id),
    provider_plan_id TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('review', 'approved', 'executing', 'completed', 'interrupted', 'failed')),
    data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(run_id, provider_plan_id)
  );
  CREATE INDEX IF NOT EXISTS session_plans_session ON session_plans(session_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS user_questions (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT NOT NULL REFERENCES session_runs(id),
    native_request_id TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending', 'answered', 'cancelled')),
    data TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT, UNIQUE(run_id, native_request_id)
  );
  CREATE INDEX IF NOT EXISTS user_questions_session ON user_questions(session_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS user_questions_pending ON user_questions(status, session_id);`);
}

function ensureGroupPlanColumns(db: DatabaseSync): void {
  addColumn(db, 'group_requests', 'intent', "ALTER TABLE group_requests ADD COLUMN intent TEXT NOT NULL DEFAULT 'normal' CHECK (intent IN ('normal', 'plan'));");
  addColumn(db, 'group_requests', 'execution_plan_id', 'ALTER TABLE group_requests ADD COLUMN execution_plan_id TEXT;');
}

function ensureArchiveColumns(db: DatabaseSync): void {
  addColumn(db, 'projects', 'archived_at', 'ALTER TABLE projects ADD COLUMN archived_at TEXT;');
  addColumn(db, 'conversation_groups', 'archived_at', 'ALTER TABLE conversation_groups ADD COLUMN archived_at TEXT;');
  db.exec('CREATE INDEX IF NOT EXISTS projects_visible ON projects(archived_at); CREATE INDEX IF NOT EXISTS conversation_groups_visible ON conversation_groups(archived_at);');
}

function ensureMessageContextColumns(db: DatabaseSync): void {
  addColumn(db, 'messages', 'context_refs_json', 'ALTER TABLE messages ADD COLUMN context_refs_json TEXT;');
  addColumn(db, 'group_messages', 'context_refs_json', 'ALTER TABLE group_messages ADD COLUMN context_refs_json TEXT;');
}

function ensureProviderHandoffColumns(db: DatabaseSync): void {
  addColumn(db, 'sessions', 'handoff_from_provider', 'ALTER TABLE sessions ADD COLUMN handoff_from_provider TEXT;');
  addColumn(db, 'sessions', 'handoff_from_model', 'ALTER TABLE sessions ADD COLUMN handoff_from_model TEXT;');
  addColumn(db, 'sessions', 'handoff_pending_at', 'ALTER TABLE sessions ADD COLUMN handoff_pending_at TEXT;');
}

function ensureTeamChatProvenanceColumns(db: DatabaseSync): void {
  addColumn(db, 'team_chat_messages', 'author_device_id', 'ALTER TABLE team_chat_messages ADD COLUMN author_device_id TEXT;');
  addColumn(db, 'team_chat_messages', 'author_signature', 'ALTER TABLE team_chat_messages ADD COLUMN author_signature TEXT;');
}

function ensureTeamDeviceTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mingle_team_device_consents (
      shared_project_id TEXT NOT NULL, account_id TEXT NOT NULL, device_id TEXT NOT NULL,
      consent_json TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(shared_project_id,account_id,device_id)
    );
    CREATE TABLE IF NOT EXISTS mingle_team_device_structures (
      shared_project_id TEXT PRIMARY KEY, team_id TEXT NOT NULL, host_device_id TEXT NOT NULL,
      structure_json TEXT NOT NULL, version INTEGER NOT NULL, received_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mingle_team_device_deliveries (
      delivery_id TEXT PRIMARY KEY, shared_project_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL, request_json TEXT NOT NULL, status TEXT NOT NULL,
      run_id TEXT, worktree_path TEXT, branch TEXT, base_revision TEXT, chat_message_id TEXT,
      error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS mingle_team_device_deliveries_agent ON mingle_team_device_deliveries(shared_project_id,agent_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS mingle_team_device_activity (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, shared_project_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      sender_device_id TEXT NOT NULL, entry_id TEXT NOT NULL, run_id TEXT, at TEXT NOT NULL,
      entry_json TEXT NOT NULL, UNIQUE(shared_project_id,agent_id,entry_id)
    );
    CREATE INDEX IF NOT EXISTS mingle_team_device_activity_agent ON mingle_team_device_activity(shared_project_id,agent_id,seq DESC);
    CREATE TABLE IF NOT EXISTS mingle_team_device_approvals (
      delivery_id TEXT NOT NULL, approval_id TEXT NOT NULL, decision TEXT NOT NULL CHECK(decision IN ('approved','denied')),
      decided_at TEXT NOT NULL, PRIMARY KEY(delivery_id,approval_id)
    );
  `);
}

function ensureSessionWorktreeBases(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS session_worktree_bases (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    base_revision TEXT CHECK (base_revision IS NULL OR length(base_revision) IN (40,64)),
    created_at TEXT NOT NULL
  );`);
}

const MIGRATIONS: (string | ((db: DatabaseSync) => void))[] = [
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, is_example INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
    effort TEXT NOT NULL, status TEXT NOT NULL, policy TEXT NOT NULL, isolated INTEGER NOT NULL, worktree_path TEXT NOT NULL, branch TEXT,
    provider_session_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL, archived_at TEXT
  );
  CREATE INDEX sessions_project ON sessions(project_id);
  CREATE TABLE messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL, content TEXT NOT NULL, kind TEXT, created_at TEXT NOT NULL, consumed_at TEXT
  );
  CREATE INDEX messages_session ON messages(session_id, seq);
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL, description TEXT NOT NULL,
    acceptance_criteria TEXT NOT NULL, session_id TEXT REFERENCES sessions(id), status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX tasks_project ON tasks(project_id);
  CREATE TABLE task_deps (
    task_id TEXT NOT NULL REFERENCES tasks(id), depends_on TEXT NOT NULL REFERENCES tasks(id), PRIMARY KEY (task_id, depends_on), CHECK (task_id <> depends_on)
  );
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, session_id TEXT, type TEXT NOT NULL, summary TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX events_project ON events(project_id, id);
  CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
  CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), tool TEXT NOT NULL, description TEXT NOT NULL, input TEXT NOT NULL,
    status TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT, resolution TEXT
  );
  CREATE INDEX approvals_session ON approvals(session_id);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  `ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE sessions ADD COLUMN unread INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE messages ADD COLUMN run_id TEXT;
   CREATE TABLE session_runs (
     id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), user_message_id TEXT NOT NULL REFERENCES messages(id),
     provider TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, duration_ms INTEGER
   );
   CREATE INDEX runs_session ON session_runs(session_id, started_at);
   CREATE TABLE tool_calls (
     id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES session_runs(id), session_id TEXT NOT NULL REFERENCES sessions(id),
     provider_id TEXT NOT NULL, category TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL,
     UNIQUE(run_id, provider_id)
   );
   CREATE INDEX tools_run ON tool_calls(run_id);
  `,
  `ALTER TABLE sessions ADD COLUMN service_tier TEXT NOT NULL DEFAULT 'standard';`,
  `ALTER TABLE session_runs ADD COLUMN changes_summary TEXT;
   ALTER TABLE session_runs ADD COLUMN changes_diff TEXT;
   ALTER TABLE session_runs ADD COLUMN changes_diff_truncated INTEGER NOT NULL DEFAULT 0;`,
  `CREATE TABLE task_sources (
     task_id TEXT PRIMARY KEY REFERENCES tasks(id), project_id TEXT NOT NULL REFERENCES projects(id),
     source_key TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(project_id, source_key)
   );
   CREATE TABLE project_context (project_id TEXT PRIMARY KEY REFERENCES projects(id), data TEXT NOT NULL);`,
  // Group conversations: a shared coordination layer above independent provider sessions. Purely additive.
  `CREATE TABLE conversation_groups (
     id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL,
     anchor_session_id TEXT NOT NULL REFERENCES sessions(id),
     mode TEXT NOT NULL CHECK (mode IN ('cowork', 'orchestrated', 'current-leads')),
     orchestrator_member_id TEXT, paused INTEGER NOT NULL DEFAULT 0, pause_reason TEXT,
     max_parallel INTEGER NOT NULL, max_turns INTEGER NOT NULL, max_hops INTEGER NOT NULL,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL
   );
   CREATE INDEX conversation_groups_project ON conversation_groups(project_id);
   CREATE TABLE group_members (
     id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES conversation_groups(id), session_id TEXT NOT NULL REFERENCES sessions(id),
     handle TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('peer', 'orchestrator', 'worker')),
     held INTEGER NOT NULL DEFAULT 0, last_read_seq INTEGER NOT NULL DEFAULT 0, joined_at TEXT NOT NULL, removed_at TEXT,
     UNIQUE(group_id, handle)
   );
   CREATE UNIQUE INDEX group_members_active_session ON group_members(session_id) WHERE removed_at IS NULL;
   CREATE INDEX group_members_group ON group_members(group_id);
   CREATE TABLE group_messages (
     seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, group_id TEXT NOT NULL REFERENCES conversation_groups(id),
     sender_member_id TEXT, recipient_member_ids TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('user', 'agent', 'assignment', 'status', 'artifact')), content TEXT NOT NULL,
     request_id TEXT, reply_to_id TEXT, source_message_id TEXT, source_run_id TEXT, client_message_id TEXT, created_at TEXT NOT NULL,
     UNIQUE(group_id, client_message_id)
   );
   CREATE INDEX group_messages_group ON group_messages(group_id, seq);
   CREATE INDEX group_messages_request ON group_messages(request_id);
   CREATE TABLE group_requests (
     id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES conversation_groups(id), message_id TEXT NOT NULL REFERENCES group_messages(id),
     planner_member_id TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'paused')),
     turns_used INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
   );
   CREATE INDEX group_requests_group ON group_requests(group_id, created_at);
   CREATE TABLE group_deliveries (
     id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES conversation_groups(id),
     request_id TEXT NOT NULL REFERENCES group_requests(id), message_id TEXT NOT NULL REFERENCES group_messages(id),
     member_id TEXT NOT NULL REFERENCES group_members(id), kind TEXT NOT NULL CHECK (kind IN ('request', 'assignment', 'message', 'result')),
     status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'interrupted', 'cancelled')),
     run_id TEXT, hop INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, retryable INTEGER NOT NULL DEFAULT 0,
     error TEXT, assignment_id TEXT, started_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
   );
   CREATE INDEX group_deliveries_state ON group_deliveries(group_id, status);
   CREATE INDEX group_deliveries_member ON group_deliveries(member_id, status);
   CREATE INDEX group_deliveries_request ON group_deliveries(request_id);
   CREATE UNIQUE INDEX group_deliveries_run ON group_deliveries(run_id) WHERE run_id IS NOT NULL;
   CREATE TABLE group_assignments (
     id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES conversation_groups(id), request_id TEXT NOT NULL REFERENCES group_requests(id),
     from_member_id TEXT NOT NULL REFERENCES group_members(id), to_member_id TEXT NOT NULL REFERENCES group_members(id),
     task_id TEXT NOT NULL REFERENCES tasks(id), delivery_id TEXT NOT NULL, scope TEXT NOT NULL, fingerprint TEXT NOT NULL,
     notified INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
   );
   CREATE INDEX group_assignments_group ON group_assignments(group_id, request_id);
   CREATE INDEX group_assignments_task ON group_assignments(task_id);
   CREATE TABLE group_artifacts (
     id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES conversation_groups(id), request_id TEXT NOT NULL REFERENCES group_requests(id),
     from_member_id TEXT NOT NULL REFERENCES group_members(id), to_member_id TEXT NOT NULL REFERENCES group_members(id),
     task_id TEXT REFERENCES tasks(id), path TEXT NOT NULL, commit_id TEXT NOT NULL, blob TEXT NOT NULL, reference TEXT NOT NULL,
     handoff_event_id INTEGER, handoff_message_id TEXT, message_id TEXT NOT NULL REFERENCES group_messages(id), created_at TEXT NOT NULL,
     UNIQUE(group_id, from_member_id, to_member_id, path, commit_id)
   );
   CREATE INDEX group_artifacts_target ON group_artifacts(group_id, to_member_id, task_id, path);
   CREATE TABLE group_assignment_inputs (
     assignment_id TEXT NOT NULL REFERENCES group_assignments(id), task_id TEXT NOT NULL REFERENCES tasks(id), path TEXT NOT NULL,
     artifact_id TEXT REFERENCES group_artifacts(id), PRIMARY KEY (assignment_id, task_id, path)
   );`,
  // A source watcher may already have opened migration 7 while group implementation was being integrated.
  // Accept both early v7 shapes; preserve every artifact and consumer link while broadening its identity.
  (db) => {
    const columns = db.prepare('PRAGMA table_info(group_deliveries)').all() as { name: string }[];
    if (!columns.some((column) => column.name === 'task_id')) db.exec('ALTER TABLE group_deliveries ADD COLUMN task_id TEXT REFERENCES tasks(id)');
    const links = db.prepare('SELECT assignment_id, task_id, path, artifact_id FROM group_assignment_inputs WHERE artifact_id IS NOT NULL').all() as { assignment_id: string; task_id: string; path: string; artifact_id: string }[];
    db.exec(`CREATE TABLE group_artifacts_v8 (
      id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES conversation_groups(id), request_id TEXT NOT NULL REFERENCES group_requests(id),
      from_member_id TEXT NOT NULL REFERENCES group_members(id), to_member_id TEXT NOT NULL REFERENCES group_members(id),
      task_id TEXT REFERENCES tasks(id), path TEXT NOT NULL, commit_id TEXT NOT NULL, blob TEXT NOT NULL, reference TEXT NOT NULL,
      handoff_event_id INTEGER, handoff_message_id TEXT, message_id TEXT NOT NULL REFERENCES group_messages(id), created_at TEXT NOT NULL
    );
    INSERT INTO group_artifacts_v8 SELECT id, group_id, request_id, from_member_id, to_member_id, task_id, path, commit_id, blob, reference, handoff_event_id, handoff_message_id, message_id, created_at FROM group_artifacts;
    UPDATE group_assignment_inputs SET artifact_id = NULL;
    DROP TABLE group_artifacts;
    ALTER TABLE group_artifacts_v8 RENAME TO group_artifacts;
    CREATE UNIQUE INDEX group_artifacts_identity ON group_artifacts(group_id, from_member_id, to_member_id, path, commit_id, COALESCE(task_id, ''));
    CREATE INDEX group_artifacts_target ON group_artifacts(group_id, to_member_id, task_id, path);`);
    const restore = db.prepare('UPDATE group_assignment_inputs SET artifact_id = ? WHERE assignment_id = ? AND task_id = ? AND path = ?');
    for (const link of links) restore.run(link.artifact_id, link.assignment_id, link.task_id, link.path);
  },
  `ALTER TABLE projects ADD COLUMN archived_at TEXT;
   CREATE INDEX projects_visible ON projects(archived_at);`,
  // Chat attachments: opaque private files plus the durable links from human messages, and one validated native invocation per group message.
  `CREATE TABLE attachments (
     id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
     scope_kind TEXT NOT NULL CHECK (scope_kind IN ('session', 'group')), scope_id TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('image', 'file')), name TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('draft', 'sent', 'deleted')), created_at TEXT NOT NULL, sent_at TEXT, deleted_at TEXT
   );
   CREATE INDEX attachments_scope ON attachments(scope_kind, scope_id, status);
   CREATE INDEX attachments_status_age ON attachments(status, created_at);
   CREATE TABLE attachment_links (
     attachment_id TEXT NOT NULL UNIQUE REFERENCES attachments(id), owner_kind TEXT NOT NULL CHECK (owner_kind IN ('message', 'group_message')),
     owner_id TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY (owner_kind, owner_id, attachment_id)
   );
   CREATE INDEX attachment_links_owner ON attachment_links(owner_kind, owner_id, position);
    ALTER TABLE group_messages ADD COLUMN invocation TEXT;`,
  // Durable bounded recovery metadata. Existing coordinator budgets and native sessions are untouched.
   `ALTER TABLE conversation_groups ADD COLUMN autonomy_policy TEXT NOT NULL DEFAULT '{"mode":"balanced"}';
    ALTER TABLE conversation_groups ADD COLUMN recovery_policy TEXT NOT NULL DEFAULT '{"automaticFallback":false}';
    ALTER TABLE conversation_groups ADD COLUMN recovery_state TEXT NOT NULL DEFAULT '{"status":"healthy"}';
   ALTER TABLE conversation_groups ADD COLUMN coordinator_epoch INTEGER NOT NULL DEFAULT 1;
   ALTER TABLE group_deliveries ADD COLUMN coordinator_epoch INTEGER NOT NULL DEFAULT 1;
   CREATE TABLE session_checkpoints (
     id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT REFERENCES session_runs(id),
     version INTEGER NOT NULL, reason TEXT NOT NULL CHECK (length(reason) <= 200),
     checkpoint_json TEXT NOT NULL CHECK (length(checkpoint_json) <= 65536), created_at TEXT NOT NULL
   );
   CREATE INDEX session_checkpoints_latest ON session_checkpoints(session_id, created_at DESC);
    CREATE TABLE session_failures (
     id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT NOT NULL REFERENCES session_runs(id),
     failure_json TEXT NOT NULL CHECK (length(failure_json) <= 8192), updated_at TEXT NOT NULL,
     UNIQUE(session_id, run_id)
    );
    CREATE INDEX session_failures_latest ON session_failures(session_id, updated_at DESC);
    CREATE INDEX session_failures_run ON session_failures(run_id);
   CREATE TABLE group_recovery_actions (
     id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES conversation_groups(id), idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) <= 100),
     action TEXT NOT NULL CHECK (length(action) <= 80), result_json TEXT NOT NULL CHECK (length(result_json) <= 8192), created_at TEXT NOT NULL,
     UNIQUE(group_id, idempotency_key)
   );
    CREATE INDEX group_recovery_actions_recent ON group_recovery_actions(group_id, created_at DESC);
    CREATE TABLE group_recovery_checkpoints (
      id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES conversation_groups(id), request_id TEXT REFERENCES group_requests(id),
      batch_id TEXT, kind TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('pending', 'acknowledged', 'dismissed')),
      reason TEXT NOT NULL CHECK (length(reason) <= 1000), payload_json TEXT NOT NULL CHECK (length(payload_json) <= 65536),
      idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) <= 100),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, acknowledged_at TEXT,
      UNIQUE(group_id, idempotency_key)
    );
    CREATE INDEX group_recovery_checkpoints_open ON group_recovery_checkpoints(group_id, state, created_at);
    CREATE TABLE group_assignment_milestones (
      id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES conversation_groups(id), assignment_id TEXT NOT NULL REFERENCES group_assignments(id),
      task_id TEXT NOT NULL REFERENCES tasks(id), label TEXT NOT NULL, acceptance_source TEXT NOT NULL CHECK (acceptance_source IN ('explicit', 'derived')),
      state TEXT NOT NULL CHECK (state IN ('pending', 'completed', 'blocked')), evidence_ref TEXT CHECK (evidence_ref IS NULL OR length(evidence_ref) <= 4096),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX group_assignment_milestones_assignment ON group_assignment_milestones(assignment_id, created_at);
    CREATE TABLE group_stall_evidence (
      id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES conversation_groups(id), member_id TEXT, request_id TEXT, delivery_id TEXT,
      assignment_id TEXT, fingerprint TEXT NOT NULL CHECK (length(fingerprint) <= 128), signal_class TEXT NOT NULL CHECK (length(signal_class) <= 80), consecutive_count INTEGER NOT NULL,
      reason TEXT NOT NULL CHECK (length(reason) <= 1000), source_run_id TEXT, source_tool_id TEXT, source_task_id TEXT, source_artifact_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX group_stall_evidence_recent ON group_stall_evidence(group_id, updated_at DESC);
    CREATE UNIQUE INDEX group_stall_evidence_fingerprint ON group_stall_evidence(group_id, COALESCE(member_id, ''), COALESCE(request_id, ''), fingerprint);`,
  // Repair databases already at v11 while also upgrading fresh/revised v11 schemas.
  (db) => {
    const failureColumns = db.prepare('PRAGMA table_info(session_failures)').all() as { name: string }[];
    if (!failureColumns.some((column) => column.name === 'resolved_at')) {
      db.exec('ALTER TABLE session_failures ADD COLUMN resolved_at TEXT');
    }
    db.exec(`CREATE TABLE group_recovery_deliveries (
      source_delivery_id TEXT PRIMARY KEY REFERENCES group_deliveries(id),
      successor_delivery_id TEXT NOT NULL UNIQUE REFERENCES group_deliveries(id),
      created_at TEXT NOT NULL
    );`);
  },
   // Migration 13 reconciles project and group archival columns across shared schema branches.
   ensureArchiveColumns,
   // Migration 14 adds durable plans and run-scoped questions; creation is safe across branch variants.
   ensurePlanTables,
   // Migration 15 remains reserved in the shared sequence for mentions.
   () => {},
   // Migration 16 persists native group-plan intent and approved execution identity.
   ensureGroupPlanColumns,
   // Migration 17 repairs databases opened against either planning migration order.
   (db) => { ensureArchiveColumns(db); ensurePlanTables(db); ensureGroupPlanColumns(db); },
   // Migration 18 preserves selected context references on session and group messages.
   ensureMessageContextColumns,
   // Migration 19 adds durable per-shared-project team chat and, while unreleased, its provenance fields.
    (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS team_chat_messages (
       id TEXT PRIMARY KEY, team_id TEXT NOT NULL, shared_project_id TEXT NOT NULL,
       author_json TEXT NOT NULL, body TEXT NOT NULL CHECK (length(body) <= 20000), mentions_json TEXT NOT NULL,
       reply_to TEXT, created_at TEXT NOT NULL, delivery_state TEXT NOT NULL CHECK (delivery_state IN ('sending','sent','failed')),
       run_state TEXT CHECK (run_state IS NULL OR run_state IN ('queued','running','awaiting-approval','completed','failed','interrupted')),
       source_session_id TEXT, source_message_id TEXT
     );
     CREATE INDEX IF NOT EXISTS team_chat_order ON team_chat_messages(team_id, shared_project_id, created_at, id);
     CREATE UNIQUE INDEX IF NOT EXISTS team_chat_import_identity ON team_chat_messages(team_id, shared_project_id, source_session_id, source_message_id)
       WHERE source_session_id IS NOT NULL AND source_message_id IS NOT NULL;`);
      ensureTeamChatProvenanceColumns(db);
    },
   // Migration 20: durable host settings, consent/roster mirrors and remote proxy runs.
   (db) => {
     db.exec(`CREATE TABLE IF NOT EXISTS mingle_team_host_projects (
       team_id TEXT NOT NULL, shared_project_id TEXT NOT NULL, local_project_id TEXT NOT NULL REFERENCES projects(id),
       owner_account_id TEXT NOT NULL, host_device_id TEXT NOT NULL, group_id TEXT NOT NULL,
       settings_json TEXT NOT NULL, leader_history_json TEXT NOT NULL DEFAULT '[]', needs_leader INTEGER NOT NULL DEFAULT 0,
       updated_at TEXT NOT NULL, PRIMARY KEY(team_id, shared_project_id)
     );
     CREATE INDEX IF NOT EXISTS mingle_team_host_project_local ON mingle_team_host_projects(local_project_id);
     CREATE TABLE IF NOT EXISTS mingle_team_host_roster (
       team_id TEXT NOT NULL, shared_project_id TEXT NOT NULL, agent_id TEXT NOT NULL, handle TEXT NOT NULL,
       role TEXT NOT NULL CHECK (role IN ('orchestrator','worker','idle')), fallback_rank INTEGER,
       removed_at TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(team_id, shared_project_id, agent_id),
       UNIQUE(team_id, shared_project_id, handle)
     );
     CREATE TABLE IF NOT EXISTS mingle_team_host_consents (
       team_id TEXT NOT NULL, shared_project_id TEXT NOT NULL, agent_id TEXT NOT NULL, owner_account_id TEXT NOT NULL,
       owner_device_id TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('granted','needs-reconsent','paused','revoked')),
       permission_level TEXT NOT NULL CHECK (permission_level IN ('supervised','full-access')),
       settings_version INTEGER NOT NULL, disclaimer_version TEXT NOT NULL, accepted_at TEXT NOT NULL, updated_at TEXT NOT NULL,
       PRIMARY KEY(team_id, shared_project_id, agent_id)
     );
     CREATE INDEX IF NOT EXISTS mingle_team_host_consent_owner ON mingle_team_host_consents(team_id,shared_project_id,owner_account_id,owner_device_id);
     CREATE TABLE IF NOT EXISTS mingle_team_proxy_sessions (
       session_id TEXT PRIMARY KEY REFERENCES sessions(id), team_id TEXT NOT NULL, shared_project_id TEXT NOT NULL,
       agent_id TEXT NOT NULL, owner_account_id TEXT NOT NULL, owner_device_id TEXT NOT NULL, handle TEXT NOT NULL,
       UNIQUE(team_id, shared_project_id, agent_id), UNIQUE(team_id, shared_project_id, handle)
     );
     CREATE INDEX IF NOT EXISTS mingle_team_proxy_owner ON mingle_team_proxy_sessions(team_id,shared_project_id,owner_device_id);
     CREATE TABLE IF NOT EXISTS mingle_team_host_deliveries (
       delivery_id TEXT PRIMARY KEY, team_id TEXT NOT NULL, shared_project_id TEXT NOT NULL, group_id TEXT NOT NULL,
       request_id TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id),
       owner_account_id TEXT NOT NULL, owner_device_id TEXT NOT NULL, run_id TEXT NOT NULL UNIQUE,
       remote_run_id TEXT, status TEXT NOT NULL, content TEXT NOT NULL, source_chat_message_id TEXT,
       artifacts_json TEXT NOT NULL DEFAULT '[]', failure_json TEXT, issued_at TEXT NOT NULL, timeout_at INTEGER NOT NULL,
       updated_at TEXT NOT NULL
     );
     CREATE INDEX IF NOT EXISTS mingle_team_host_delivery_live ON mingle_team_host_deliveries(team_id,shared_project_id,status,timeout_at);
     CREATE TABLE IF NOT EXISTS mingle_team_host_approvals (
       approval_id TEXT PRIMARY KEY REFERENCES approvals(id), team_id TEXT NOT NULL, shared_project_id TEXT NOT NULL,
       delivery_id TEXT NOT NULL REFERENCES mingle_team_host_deliveries(delivery_id), remote_approval_id TEXT NOT NULL,
       owner_device_id TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('pending','approved','denied','expired')),
       expires_at TEXT NOT NULL, UNIQUE(delivery_id,remote_approval_id)
     );`);
   },
    // Migration 21 keeps owner-device team state local and creates every table/index idempotently.
    ensureTeamDeviceTables,
    // Migration 22 records the Git commit each newly-created session worktree started from.
    ensureSessionWorktreeBases,
    // Migration 23 keeps terminal owner-device status payloads durable until mailbox enqueue succeeds.
    (db) => addColumn(db, 'mingle_team_device_deliveries', 'terminal_status_json',
      'ALTER TABLE mingle_team_device_deliveries ADD COLUMN terminal_status_json TEXT;'),
    // Migration 24 persists at-most-once automatic session continuation intents across restarts.
    `CREATE TABLE IF NOT EXISTS session_resume_queue (
       run_id TEXT PRIMARY KEY REFERENCES session_runs(id), session_id TEXT NOT NULL REFERENCES sessions(id),
       reason TEXT NOT NULL, created_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 1),
       state TEXT NOT NULL CHECK (state IN ('queued','starting','resumed','skipped')),
       task_id TEXT, resumed_run_id TEXT, skipped_reason TEXT
     );
     CREATE INDEX IF NOT EXISTS session_resume_queue_state ON session_resume_queue(state, created_at);`,
    // Migration 25 keeps autonomous budget extensions durable per request without rewriting group settings.
    (db) => {
      addColumn(db, 'group_requests', 'auto_turn_limit', 'ALTER TABLE group_requests ADD COLUMN auto_turn_limit INTEGER CHECK (auto_turn_limit BETWEEN 2 AND 200);');
      addColumn(db, 'group_requests', 'auto_max_hops', 'ALTER TABLE group_requests ADD COLUMN auto_max_hops INTEGER CHECK (auto_max_hops BETWEEN 1 AND 24);');
    },
    // Migration 26 preserves provider cooldowns used by group health and routing.
  `CREATE TABLE IF NOT EXISTS group_provider_cooldowns (
        group_id TEXT NOT NULL REFERENCES conversation_groups(id) ON DELETE CASCADE,
        member_id TEXT NOT NULL REFERENCES group_members(id) ON DELETE CASCADE,
        provider TEXT NOT NULL, reason TEXT NOT NULL, until TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(group_id, member_id, provider)
      );
      CREATE INDEX IF NOT EXISTS group_provider_cooldowns_until ON group_provider_cooldowns(until);`,
    `CREATE TABLE IF NOT EXISTS queued_messages (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      content TEXT NOT NULL, intent TEXT NOT NULL, skills_json TEXT NOT NULL, attachment_ids_json TEXT NOT NULL,
      context_refs_json TEXT NOT NULL, created_at TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS queued_messages_order ON queued_messages(session_id, created_at, id);`,
    (db) => addColumn(db, 'conversation_groups', 'preferred_coordinator_member_id',
      'ALTER TABLE conversation_groups ADD COLUMN preferred_coordinator_member_id TEXT;'),
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function openDatabase(file: string): DatabaseSync {
  const existed = file === ':memory:' || existsSync(file);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  if (row.user_version > MIGRATIONS.length) throw new Error(`Database schema v${row.user_version} is newer than this server (v${MIGRATIONS.length}).`);
  for (let version = row.user_version; version < MIGRATIONS.length; version++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const migration = MIGRATIONS[version]!;
      if (typeof migration === 'string') db.exec(migration);
      else migration(db);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  // Reconcile databases which applied the unreleased first version of migration 19 before
  // its provenance columns were added. The operation is deliberately idempotent.
  ensureTeamChatProvenanceColumns(db);
  // Session handoff state is additive and reconciled for every supported historical schema.
  ensureProviderHandoffColumns(db);
  if (!existed && file !== ':memory:') {
    try { chmodSync(file, 0o600); } catch { /* best effort on platforms without POSIX modes */ }
  }
  return db;
}
