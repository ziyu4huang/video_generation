/**
 * Idempotent SurrealQL bootstrap for the hermes-memory CRUD journal store.
 * Run by SurrealBackend.init(). The `${ns}` / `${db}` template-literal
 * parameters are the caller's namespace/database (DEFINEd first, since v3
 * does NOT lazily create them). Field names are camelCase to match the
 * repository DTOs.
 *
 * `tagged_in` indexes the edge source (`in`) to speed the `DELETE FROM tagged
 * WHERE in = ...` cleanup in syncGraphEdges. (The backfill orphan check walks
 * `count(->tagged)` and does not read `tagged.in`, but other paths still do.)
 */
export const SURREAL_BOOTSTRAP_SQL = (ns: string, db: string): string => `
DEFINE NAMESPACE IF NOT EXISTS ${ns};
DEFINE DATABASE IF NOT EXISTS ${db};
DEFINE TABLE IF NOT EXISTS memories SCHEMALESS;
DEFINE TABLE IF NOT EXISTS sessions SCHEMALESS;
DEFINE TABLE IF NOT EXISTS messages SCHEMALESS;
DEFINE TABLE IF NOT EXISTS session_files SCHEMALESS;
DEFINE TABLE IF NOT EXISTS seq SCHEMALESS;
DEFINE TABLE IF NOT EXISTS tag SCHEMALESS;
DEFINE TABLE IF NOT EXISTS tagged SCHEMALESS;
DEFINE TABLE IF NOT EXISTS session_assembly SCHEMALESS;
DEFINE TABLE IF NOT EXISTS session_assembly_meta SCHEMALESS;
DEFINE ANALYZER IF NOT EXISTS hermes_en TOKENIZERS class FILTERS snowball(english);
DEFINE INDEX IF NOT EXISTS memory_fts ON TABLE memories FIELDS content FULLTEXT ANALYZER hermes_en;
DEFINE INDEX IF NOT EXISTS message_fts ON TABLE messages FIELDS content FULLTEXT ANALYZER hermes_en;
DEFINE INDEX IF NOT EXISTS memories_content ON TABLE memories FIELDS content;
DEFINE INDEX IF NOT EXISTS memories_md_id ON TABLE memories FIELDS mdId UNIQUE;
DEFINE INDEX IF NOT EXISTS tagged_in ON TABLE tagged FIELDS in;
DEFINE INDEX IF NOT EXISTS session_assembly_md_id ON TABLE session_assembly FIELDS mdId;
DEFINE INDEX IF NOT EXISTS session_assembly_session ON TABLE session_assembly FIELDS sessionId;
DEFINE INDEX IF NOT EXISTS session_assembly_meta_sid ON TABLE session_assembly_meta FIELDS sessionId UNIQUE;
IF array::len((SELECT id FROM seq:memory)) = 0 { CREATE seq:memory SET value = 0; };
`;
