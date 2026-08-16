/**
 * composition/knowledge-semantic.ts — slice 08b2-1 of the index.ts decomposition.
 *
 * Extracted VERBATIM (behavior preserved) from index.ts L98-158 (both private
 * in index.ts; exported here for the rewire slice):
 * - DEFAULT_VECTOR_DATABASE    ← L102 (module-local const, stays module-local —
 *   only its co-moved consumer references it)
 * - buildKnowledgeSemanticOpts ← L111-158
 *
 * Inline `import("…")` type references re-anchored ./ → ../ for the one-level
 * deeper module path; everything else byte-identical.
 *
 * index.ts still holds its own copies until the rewire slice — this module
 * must typecheck standalone; it is not imported yet.
 */
import { derivePerUserNamespace } from "../store/surreal/per-user-db.js";
import {
	buildGraphRelationsFetcher,
	buildLexicalRecall,
	buildEntityRecall,
} from "../tools/knowledge-search-tool.js";
import { SurrealClient } from "../store/surreal/surreal-client.js";
import { createVectorStore } from "../store/surreal/vector-store.js";
import { defaultEmbedder, SEMANTIC_MODEL_DEFAULT } from "../store/surreal/embedder.js";

/** Dedicated database for the card_vectors HNSW side-table. Lives in the
 *  per-user namespace (same as the CRUD store when dbBackend=surrealdb) but in
 *  its OWN database so the vector index is independent of the CRUD backend
 *  (sqlite-vec is not loadable under Bun — Decision 04 Fork C). */
const DEFAULT_VECTOR_DATABASE = "vectors";

/** Build the (optional) semantic-search wiring for knowledge_search (ticket 14
 *  phase A). Conservative: returns undefined providers unless `surreal.endpoint`
 *  is explicitly configured, so the DEFAULT (sqlite, no endpoint) path is
 *  byte-identical to the pre-semantic baseline (#default-behavior-unchanged).
 *  The providers are LAZY — they only construct a client/embedder when
 *  knowledge_search is called with `semantic:true`, so session init never
 *  touches SurrealDB / LM Studio. */
export function buildKnowledgeSemanticOpts(
	config: import("../types.js").MemoryConfig,
	memoryDir: string,
): import("../tools/knowledge-search-tool.js").KnowledgeSemanticOpts | undefined {
	const endpoint = config.surreal?.endpoint;
	if (!endpoint) return undefined; // default config has no endpoint → unchanged behavior
	const ns = config.surreal?.namespace ?? derivePerUserNamespace();
	const db = DEFAULT_VECTOR_DATABASE;
	const username = config.surreal?.username ?? "root";
	const password = config.surreal?.password ?? "root";
	const model = config.embedModel ?? SEMANTIC_MODEL_DEFAULT;
	const ef = config.vectorEf ?? 100;
	// One client per wiring (cheap — HTTP/stateless). Constructed lazily on first
	// provider call, reused across calls via the closure-cached singleton.
	let client: SurrealClient | undefined;
	let store: import("../store/surreal/vector-store.js").VectorStore | undefined;
	return {
		model,
		ef,
		// ③ (fix-wave 2): wire the production batched graph-relations lookup so
		// dedupByRelation is live on the warm path. Rides the same gating as the
		// vector store above — the default (no surreal endpoint) path stays
		// byte-identical with the seam unwired.
		fetchRelations: buildGraphRelationsFetcher(memoryDir),
		// Ticket 20 T3: the two independent recall signals for the warm-path
		// frequency vote — FTS membership (lexical) + query-entity × graph scan
		// (entity). Same gating as fetchRelations above (only when a surreal
		// endpoint is configured); silent-skip inside each builder.
		lexicalRecall: buildLexicalRecall(memoryDir),
		entityRecall: buildEntityRecall(memoryDir),
		// Ticket 20 T2: frequency-vote dominance weight, threaded from config
		// (4-point registration; see constants.ts / config.ts).
		boostWeight: config.boostWeight,
		vectorStore: () => {
			if (!client) client = new SurrealClient({ endpoint, namespace: ns, database: db, username, password });
			if (!store) store = createVectorStore(client, ns, db);
			return store;
		},
		embedder: () => {
			const base = config.lmStudioBaseUrl ?? "http://127.0.0.1:1234";
			// The embedder is constructed unconditionally (cheap); if LM Studio is
			// down, embedQuery swallows the error and searchSemantic falls through to
			// the T5(a) lexical fallback — so we don't gate on lmStudioAvailable here
			// (avoids a probe round-trip on every call; the embed call itself fails
			// fast). Tests inject their own embedder.
			return defaultEmbedder({ baseUrl: base });
		},
	};
}
