# 02 — Remnic retrieval stack: deep-dive + portability

type: research
blocked by: —

## Question

How does **Remnic** actually do retrieval, and how much of it ports onto hermes?

Study the local clone at `/Users/huangziyu/proj/pi-ext-remnic-memory` — primarily
`src/search/`, `src/routing/`, `src/compounding/`, `src/namespaces/`, and the
`remnic-core` / `remnic-server` packages. The README claims: **hybrid search
(BM25 + vector + reranking)**, **graph recall**, **memory-worth scoring**, and
**per-result provenance**.

Map, concretely:

1. **Data flow** — from a memory write to a recalled result: what's indexed, in
   what format, by which index (BM25? ANN/vector? graph edges?).
2. **The vector path** — which embedding model, dim, quantization; local or API;
   what dependency it pulls in.
3. **Reranking** — model-based or heuristic; cost; where it sits in the pipeline.
4. **Graph recall + memory-worth scoring + provenance** — what these add beyond
   ranked lexical+vector hits, and what data they require.
5. **Index rebuild / maintenance** — how indexes are built and kept fresh
   (see `src/maintenance/`).

Then the portability verdict (fed into ticket 06, not decided here):

- What ports onto **hermes's SQLite-FTS5 + MD-source-of-truth** spine with
  *minimal* new substrate?
- Under **no-CUDA / MLX-only / Apple-Silicon**, where do embeddings come from
  (graduates the "embedding source" fog)? Is a reranker affordable on MPS?
- Does it need a new storage substrate (graduates the "substrate" fog) —
  `sqlite-vec`, reviving hermes's off-by-default SurrealDB backend, or new?

## Resolution

_Closed (research) — `remnic_research_fanout` workflow, 2026-07-29. Findings arm verdict ticket 06._

### Architecture note (resolves the stubs)

`src/search/`, `src/routing/`, `src/compounding/`, `src/namespaces/`, `src/maintenance/` under the repo root are **1-line re-export stubs** (e.g. `src/search/port.ts` -> `export * from "@remnic/core/search/port"`). The real implementations live in **`packages/remnic-core/src/`**.

### 1. DATA FLOW — write -> index -> recall

The search subsystem is a pluggable **`SearchBackend` port** (`packages/remnic-core/src/search/port.ts`) with six implementations selected by `createSearchBackend` (`search/factory.ts`): **QmdClient (default)** — BM25+vector+rerank inside an external native binary; **OramaBackend** — FTS + `vector[dim]` field, pure JS, JSON `.msp` files; **LanceDbBackend** — Arrow columnar via native `@lancedb`; **MeilisearchBackend** — server-side hybrid; **RemoteSearchBackend** — REST proxy; **NoopSearchBackend** — graceful degradation.

**Write path.** A memory is a Markdown file (YAML frontmatter + body). `scanMemoryDir` parses each into `IndexableDocument { docid, path, content (body, no frontmatter), snippet (~200 chars) }`. For Orama/Lance: `updateCollection()` inserts rows with a **zero vector** + `vectorProvider` tag, then `embed()`/`embedCollection()` back-fills real vectors and re-persists. Throttled: `QMD_UPDATE_BACKOFF_MS = 15m`, `QMD_EMBED_BACKOFF_MS = 60m`.

**Recall path.** `backend.hybridSearch()` -> `QmdSearchResult { docid, path, snippet, score, line?, explain?, namespace?, sourceConnector? }`. The recall pipeline (`orchestration/recall-search-pipeline.ts`) then layers: query-aware prefilter -> candidate fetch (hot/cold/archive fallback) -> `boostSearchResults` (recency/access/importance/relevance) -> `applyMemoryWorthRerank` -> `applyTrustScoreRerank` -> `expandResultsViaGraph` (PPR) -> `rerankLocalOrNoop` (LLM judge) -> dedupe/diversify/limit. Final score = lexical+vector base * heuristic boosts * worth factor * trust factor, then reordered by an LLM.

### 2. THE VECTOR PATH

- **Default model: `text-embedding-3-small`, dim 1536** (`EmbedHelper.DEFAULT_OPENAI_MODEL`; Lance/Orama default dim 1536).
- **Three provider kinds:** **`openai`** — HTTP `/embeddings`, needs `openaiApiKey`; **`local`** — any OpenAI-compatible `/v1/embeddings` server at `localLlmUrl` (LM Studio/Ollama); **`host`** — a provider the host process registers via `registerHostEmbeddingProvider`, queried in-process. Resolution rotates host->openai->local with a 250ms cache.
- **No quantization** — vectors are plain `number[]` (float). **No MLX embedding model anywhere.**
- **QMD binary** (default backend) bundles its own embed/rerank/generate models inside `@tobilu/qmd`; has `qmdGpuBackend`/`qmdForceCpu` knobs — expects a GPU, shipped as a native binary.
- **Verdict:** vector path is **API- or HTTP-server-driven**, plus a host-injection seam.

### 3. RERANKING

Two rerankers: **QMD internal** (opaque, in binary, on by default); and **`rerankLocalOrNoop`** — a **model-based LLM-as-judge** (not a cross-encoder): JSON prompt to `chatCompletion` scoring each candidate 0-100, parsed `{scores:[{id,score}]}`, sorted, TTL-cached (`RerankCache`). Sits after candidate fetch + boosts; gated by `enabled`, capped at `maxCandidates`. Cost = one short LLM call per unique (query, candidate-set).

### 4. GRAPH RECALL + MEMORY-WORTH + PROVENANCE

- **Graph recall** (`graph-recall.ts`): builds an **in-memory** `RemnicGraph` from the candidate pool, runs **Personalized PageRank** seeded by top-hit ids. **Default OFF.** Pure, no graph DB. Needs edge extraction (entity links).
- **Memory-worth scoring** (`memory-worth.ts`): pure fn reading `mw_success`/`mw_fail` frontmatter counters, **Laplace-smoothed success probability** `(s+1)/(s+f+2)` with optional exp recency decay; filter applies `new_score = old_score * (p_success/0.5)` so uninstrumented memories stay neutral. **Default OFF.**
- **Provenance** (`provenance.ts`): frontmatter `sources[]` (`{sessionKey, turnId, observedAt, quote, charStart, charEnd}`) + coarse enum (`verified`/`unverified`/`none`); write path enforces "verified requires surviving sources." **Pure frontmatter metadata, no index.**

### 5. INDEX REBUILD / MAINTENANCE

Incremental `update()`/`embed()` per collection, fail-open with min-interval + backoff; `updateStrict`/`embedStrict` for guaranteed refresh. **Projection rebuild** (`maintenance/rebuild-memory-projection.ts`): reads all MD tiers -> dedupes by memory id -> writes a **`better-sqlite3` projection DB** (`memory_current`, `memory_timeline`, `memory_entity_mentions`, governance queue) with atomic temp-file + backup stamp, verify (row-diff), repair. **This is exactly a "MD source of truth -> SQLite mirror" pattern** — hermes's own shape.

### Portability verdict

**Ports onto SQLite-FTS5 + MD spine, minimal new substrate:**
1. **Memory-worth scoring** — pure frontmatter counters + pure fn. Wire `mw_success/mw_fail` on session outcome, apply `p_success/0.5` multiplier to `memory_search`. **Zero new substrate. Highest value-to-effort.**
2. **Provenance (`sources[]` + enum)** — pure frontmatter. **Zero new substrate.**
3. **LLM-judge reranker** — reuse hermes `spawnSubagent`/host LLM to rerank top-K with JSON scoring + TTL cache. **No new substrate.**
4. **Boost multipliers + degradation-aware search** — pure scoring + observability on existing FTS5. **No new substrate.**
5. **Graph recall (PPR)** — Remnic builds the graph **in-memory from the candidate pool**, no graph store. Port as an optional expansion tier over `memory_search` candidates; needs an edge extractor. **Do NOT revive SurrealDB for this.**

**Needs a NEW substrate (the vector layer) — MLX-native options exist:** the one capability FTS5-only lacks. Under no-CUDA/MLX:
- **`sqlite-vec`** (loadable SQLite ext, pure C, no CUDA) — add a `vec0` virtual table beside the FTS5 mirror. Cleanest "vector layer added onto the spine." Embeddings from one of:
  - **In-process MLX embedding model** via the existing `python/venv` MLX stack — keeps `--offline`, Apple-Silicon-native, bfloat16. **Recommended**, needs an MLX sentence-embedding model pick.
  - **Host-injected provider** (Remnic's `hostEmbeddingProvider` seam) — let pi supply embeddings; no cost if a local model is wired.
  - **API (`text-embedding-3-small`)** — Remnic's default; lowest effort but **network egress + cost conflict** with hermes `--offline` ethos. Opt-in only.

**OUT / suspect:** QMD binary (external native, GPU backend); LanceDB/Meilisearch/FAISS (heavy native/server deps, FAISS not MLX-native); OramaBackend (duplicates SQLite-FTS5); SurrealDB revival for graph (unnecessary).

**Bottom line:** Remnic's scoring/provenance/rerank/graph layers are substrate-light and port almost wholesale onto hermes's MD+SQLite-FTS5 spine as pure post-processing of `memory_search`. The **only** genuinely new substrate is vector storage + embeddings; `sqlite-vec` + an MLX (or host-injected) embedding model satisfies no-CUDA/Apple-Silicon, with API embedding as explicit opt-in.
