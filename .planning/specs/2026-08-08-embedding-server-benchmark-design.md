# Local Embedding Server — Phase 0 Benchmark Harness

## Context

The user wants a fast, high-quality local text embedding server on Apple Silicon,
installable as a macOS background service, with an existing question: build our
own (Swift + MLX) vs. reuse an existing solution (LM Studio, llama.cpp)?

Research findings (2026-08-08):

- **LM Studio** (already installed) — GUI app, has an MLX backend on Apple Silicon
  (blogged as 30–50% faster than llama.cpp on Metal), OpenAI-compatible
  `/v1/embeddings` on `localhost:1234`, headless `llmster` deployment mode exists.
  Embedding model curation is narrower than raw MLX and it's a third-party
  black box — no control over batching, quantization, or repo-specific extension.
- **llama.cpp** (already installed via `brew`) — `llama-server --embedding` gives
  an OpenAI-compatible embedding endpoint, Metal-accelerated, broadest model
  coverage via GGUF. Mature and battle-tested, but not MLX (different
  quantization/kernel stack than what the user wants).
- **MLX ecosystem** — `ml-explore/mlx-swift-lm` (official) ships `MLXEmbedders`,
  a ready-made Swift + MLX embedding module supporting BGE-M3, Nomic-Embed-v1.5,
  Multilingual-E5, Snowflake, etc. A Swift production server would wrap this
  rather than reimplement model inference. Python-side equivalents
  (`mlx-embeddings`, `mlx_embedding_models`) exist for fast prototyping.
- Repo precedent (`project_ltx_swift_native_port` memory): Python is dev-only,
  Swift-native is production, repo-wide. A future production embedding server
  should follow this rule.

Hardware: Apple M5 Max, 128GB RAM — comfortably runs any of the candidate models.

## Decision

Two-phase approach. **This spec covers Phase 0 only.**

- **Phase 0 (this spec)**: build a benchmark harness that measures LM Studio vs.
  llama.cpp vs. MLX-native (Python) across 2–3 candidate embedding models, on
  real corpus data, for both latency and retrieval quality. The report decides
  whether Phase 1 is worth doing.
- **Phase 1 (future, contingent on Phase 0 results)**: if MLX-native wins by a
  meaningful margin, build a thin Swift HTTP server wrapping `mlx-swift-lm`'s
  `MLXEmbedders`, exposing OpenAI-compatible `/v1/embeddings`, deployed via a
  launchd plist. Not designed here — a separate spec once Phase 0 has data.

## Scope

Use cases the eventual server must serve (informs corpus/eval choice, not
Phase 0 itself): general local embedding API for other tools, RAG/document
retrieval, and semantic search over this repo's own content.

## Corpus

Two real sources (no synthetic/toy corpus):

1. This repo's `docs/**/*.md`.
2. `/Users/huangziyu/proj/study-news/content/**/*.md` — an Obsidian vault with
   mixed Chinese/English notes. This rules out English-only candidate models.

## Candidate models

All three are multilingual, so the corpus's Chinese content doesn't
disqualify any candidate on language coverage alone:

1. **BGE-M3** (MIT, 100+ languages, dense+sparse retrieval)
2. **Qwen3-Embedding-0.6B** (Apache-2.0, MTEB-eng-v2 70.7, multilingual)
3. **Nomic-Embed-Text-v1.5** (continuity reference — `study-news` already has a
   cached embedding file computed with this model at
   `study-news/.knowledge-semantic/text-embedding-nomic-embed-text-v1-5.json`;
   report must flag if its Chinese coverage looks weak relative to the other two)

## Architecture

New standalone directory, isolated from `mlx-movie-director`'s pinned
diffusers/torch/mlx dependency set (this is a throwaway research tool, not a
production dependency):

```
python/embed-bench/
  run.py              # CLI entry point: runs all backend x model combos, emits report
  corpus.py           # loads + chunks markdown (split by heading, ~200-500 tokens/chunk)
  query_gen.py        # generates 1-2 synthetic queries per chunk via a local LLM
                       # (LM Studio's already-loaded judge model)
  backends/
    lmstudio.py        # HTTP client: POST localhost:1234/v1/embeddings
    llamacpp.py         # HTTP client: llama-server --embedding endpoint
    mlx_native.py        # in-process call into mlx-embeddings/mlx_embedding_models,
                          # no HTTP hop, measures pure inference latency
  metrics.py           # Recall@1, Recall@5, MRR, p50/p95 latency, batch throughput
  report.py            # renders markdown table + writes raw JSON results
```

Isolated venv under `python/embed-bench/` (not `python/venv`), since this tool
carries its own dependency set unrelated to the movie-director pipeline.

## Measurement methodology

**Quality**: for each backend×model combination, embed every corpus chunk to
build an index, embed every synthetic query, rank corpus chunks by cosine
similarity, and check whether the chunk the query was generated from appears
in the top-1 (Recall@1) / top-5 (Recall@5) results. Also compute MRR.

**Speed**: single-request latency over 50 reps (report p50/p95), and
batch-of-32 throughput (embeddings/sec).

**Missing combinations**: if a backend doesn't have a given model available
(e.g., not in LM Studio's curated registry), skip that combination and mark it
"not tested" in the report rather than failing the whole run.

## Output

A markdown report (table: combination × Recall@5 × MRR × p50 latency ×
throughput) plus the raw JSON results backing it. This report is the input to
the Phase 1 go/no-go decision — no code decisions are made in this spec beyond
producing that data.

## Testing

- `metrics.py` (Recall@k/MRR math) — unit tested; a metrics bug would silently
  invalidate every comparison.
- `corpus.py` (chunking logic) — unit tested; deterministic and easy to verify.
- `query_gen.py` and `backends/*` — no unit tests; these call real local
  services and are validated by running them, not mocking them.

## Out of scope

- Building the Phase 1 Swift server (separate future spec).
- launchd packaging.
- Any production API design (OpenAI-compat schema work happens in Phase 1).
