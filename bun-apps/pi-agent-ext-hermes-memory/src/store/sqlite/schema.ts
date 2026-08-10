/**
 * SQLite schema for pi-hermes-memory v0.4
 *
 * Tables:
 * - sessions — Pi session metadata
 * - session_files — indexed JSONL metadata for incremental backfill
 * - messages — all conversation messages
 * - message_fts — FTS5 index for full-text search across messages
 * - memories — extended memory entries (unlimited, searchable)
 * - memory_fts — FTS5 index for memory search
 */

export const SCHEMA_SQL = `
  -- Extension key/value metadata
  CREATE TABLE IF NOT EXISTS extension_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Session metadata
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    cwd TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    message_count INTEGER DEFAULT 0
  );

  -- Indexed session file metadata for cheap incremental backfill
  CREATE TABLE IF NOT EXISTS session_files (
    path TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    size INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL,
    indexed_at TEXT NOT NULL
  );

  -- All messages from all sessions
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    tool_calls TEXT
  );

  -- FTS5 index for full-text search across messages
  -- content='messages' + content_rowid='rowid' keeps FTS in sync with the content table
  CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
    content,
    content='messages',
    content_rowid='rowid'
  );

  -- Triggers to keep message_fts in sync with messages table
  CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO message_fts(rowid, content) VALUES (new.rowid, new.content);
  END;

  CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO message_fts(message_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  END;

  CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO message_fts(message_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    INSERT INTO message_fts(rowid, content) VALUES (new.rowid, new.content);
  END;

  -- Extended memory entries (beyond MEMORY.md limit)
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT,
    target TEXT NOT NULL CHECK (target IN ('memory', 'user', 'failure', 'knowledge', 'planning-effort', 'planning-ticket')),
    category TEXT CHECK (category IN ('failure', 'correction', 'insight', 'preference', 'convention', 'tool-quirk')),
    content TEXT NOT NULL,
    failure_reason TEXT,
    tool_state TEXT,
    corrected_to TEXT,
    created DATE NOT NULL,
    last_referenced DATE NOT NULL,
    mw_success INTEGER NOT NULL DEFAULT 0,
    mw_fail INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    supersedes INTEGER,
    superseded_by INTEGER,
    parent_ids TEXT,
    md_id TEXT,
    state TEXT NOT NULL DEFAULT 'active',
    severity INTEGER,
    pin INTEGER NOT NULL DEFAULT 0,
    -- 06a (knowledge-pipeline): nullable JSON envelope for kinds whose metadata
    -- has no dedicated column (knowledge-cards). NULL for memory/user/failure
    -- rows (their metadata stays in the dedicated columns above, unchanged).
    frontmatter TEXT
  );

  -- FTS5 index for memory search
  -- content='memories' + content_rowid='id' keeps FTS in sync
  CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    content,
    content='memories',
    content_rowid='id'
  );

  -- Triggers to keep memory_fts in sync with memories table
  CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memory_fts(rowid, content) VALUES (new.id, new.content);
  END;

  CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, content) VALUES ('delete', old.id, old.content);
  END;

  CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, content) VALUES ('delete', old.id, old.content);
    INSERT INTO memory_fts(rowid, content) VALUES (new.id, new.content);
  END;

  -- Indexes for common queries
  CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
  CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
  CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project);
  CREATE INDEX IF NOT EXISTS idx_memories_target ON memories(target);
  CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
  CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
  CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at);
  CREATE INDEX IF NOT EXISTS idx_session_files_session_id ON session_files(session_id);

  -- Stable secondary join key (.md ↔ DB). Nullable during backfill: SQLite
  -- UNIQUE treats NULLs as distinct, so un-backfilled rows coexist.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_md_id ON memories(md_id);

  -- 09-impl (knowledge-pipeline / ticket 09): content-hash state for the
  -- planning-card mirror (Tier-1, md-wins drift). 'kind' discriminator so 10-impl
  -- can add dep-validation hashes (kind='validated') WITHOUT a migration.
  CREATE TABLE IF NOT EXISTS card_md_hash (
    card_id TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    mirrored_at DATE NOT NULL,
    kind TEXT NOT NULL DEFAULT 'mirror'
  );
  CREATE INDEX IF NOT EXISTS idx_card_md_hash_kind ON card_md_hash(kind);

  -- 10-impl (knowledge-pipeline / ticket 10): per-card aggregate hash of a
  -- planning-card's cited+declared source-file deps (the staleness baseline).
  -- SEPARATE from card_md_hash because that table's card_id is the SOLE PK
  -- (taken by the mirror hash) — a kind='validated' row there would collide.
  -- ONE aggregate row per card (no kind discriminator).
  CREATE TABLE IF NOT EXISTS card_dep_hash (
    card_id TEXT PRIMARY KEY,
    dep_hash TEXT NOT NULL,
    validated_at DATE NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_card_dep_hash ON card_dep_hash(card_id);

  -- Per-session prompt-provenance (UPSP §5): one row per md_id assembled into a session's
  -- memory block. FK-FREE by design — the sessions row is created later by deferred backfill,
  -- so session_id is a plain join key, not an enforced FK. Composite PK dedupes; md_id index
  -- backs "which sessions saw memory M?".
  CREATE TABLE IF NOT EXISTS session_assembly (
    session_id TEXT NOT NULL,
    md_id TEXT NOT NULL,
    -- UPSP §9 "used vs dropped" (ticket #06): null at capture (surfaced),
    -- set to an ISO timestamp when the agent's output first references the
    -- entry (used). Surfaced-but-never-used = used_at IS NULL.
    used_at TEXT,
    PRIMARY KEY (session_id, md_id)
  );

  CREATE INDEX IF NOT EXISTS idx_session_assembly_md_id ON session_assembly(md_id);

  -- Per-session block hash (the receipt). Separate from sessions (NOT NULL project/cwd +
  -- post-capture row creation make hash-on-sessions unreliable). One row per session.
  CREATE TABLE IF NOT EXISTS session_assembly_meta (
    session_id TEXT NOT NULL PRIMARY KEY,
    hash TEXT NOT NULL,
    captured_at TEXT NOT NULL
  );
`;
