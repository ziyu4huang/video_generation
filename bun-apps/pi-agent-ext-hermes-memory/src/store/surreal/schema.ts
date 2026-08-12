/**
 * @upstream(LeanRAG) concept ④ — HNSW index definition (ticket 14).
 * `DEFINE INDEX ... HNSW DIMENSION 768 DIST COSINE TYPE F32` is the vector-ANN
 * entry point that supersedes LeanRAG's Milvus IVF_FLAT/IP. See ADR-0001.
 *
 * Idempotent SurrealQL bootstrap for the hermes-memory backend.
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

/**
 * SEPARATE bootstrap for the card_vectors HNSW side-table (ticket 14 phase A).
 * The vector index MUST be able to init against SurrealDB regardless of the
 * CRUD backend — the default CRUD backend is SQLite (sqlite-vec is not loadable
 * under Bun — Decision 04 Fork C), so the HNSW index lives in its OWN Surreal
 * ns/db and is bootstrapped independently of `SURREAL_BOOTSTRAP_SQL`.
 *
 * `card_vectors` is SCHEMALESS: { mdId, kind, modelVersion, contentHash, vec }.
 * The composite-key index (mdId, modelVersion) lets `missingMdIds` diff the
 * cold set cheaply; `card_vec_hnsw` is the HNSW index (768-dim, COSINE, F32)
 * used by the KNN query. Re-embedding is idempotent: rows are keyed by a
 * backtick-quoted record id `${mdId}__${modelVersion}` so a re-upsert of the
 * same key overwrites (verified against v3.2.3).
 *
 * The `${ns}` / `${db}` are the caller's vector-store namespace/database
 * (DEFINEd first, since v3 does NOT lazily create them).
 */
export const VECTOR_BOOTSTRAP_SQL = (ns: string, db: string): string => `
DEFINE NAMESPACE IF NOT EXISTS ${ns};
DEFINE DATABASE IF NOT EXISTS ${db};
DEFINE TABLE IF NOT EXISTS card_vectors SCHEMALESS;
DEFINE INDEX IF NOT EXISTS card_vectors_key ON TABLE card_vectors FIELDS mdId, modelVersion;
DEFINE INDEX IF NOT EXISTS card_vec_hnsw ON TABLE card_vectors FIELDS vec HNSW DIMENSION 768 DIST COSINE TYPE F32;
`;
