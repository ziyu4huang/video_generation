# embed-mlx-server quality-check: design

## Context

Phase 0 (`python/embed-bench`, PR #1128) benchmarked BGE-M3 recall quality across
LM Studio, llama.cpp, and a raw-Python MLX backend on two real corpora
(`docs/`, `study-news`). It found MLX-native ~2x faster than LM Studio but with
a meaningfully lower recall (e.g. `repo-docs-fixed`: LM Studio recall@1=0.709
vs. Python `mlx_native` recall@1=0.506). The obvious suspect — 512-token
truncation — was tested and ruled out. Root cause is still unexplained.

Phase 1 (`swift/embed-mlx-server`, PR #1167, merged) built a production Swift +
MLX server around BGE-M3 and deliberately scoped the quality gap out as an
accepted limitation. Today's testing of the live service (now running on port
8090 via launchd) has been functional smoke-testing only — curl round-trips,
multilingual input, error paths — never a quality/recall measurement.

**Open question this closes:** does the live Swift server reproduce Phase 0's
recall gap (meaning the gap is a model/conversion-level property, inherited
correctly), or does it perform worse than the raw Python `mlx_native` backend
(meaning there's a Swift-side bug beyond what Phase 0 measured)? The answer
determines whether there's real "improve the server code" work here or whether
the open question gets closed as inherited-and-accepted.

## Decision

Add a fourth backend module to the existing `python/embed-bench` harness —
`backends/embed_mlx_server.py` — that talks HTTP to the live server's
`/v1/embeddings`, matching the shape of `backends/lmstudio.py`
(`is_available()` + `embed_batch()`). Wire it into `run.py` and run all three
live backends (`lmstudio`, `mlx_native`, `embed_mlx_server`) together in one
fresh pass per corpus, so results are directly comparable — synthetic queries
are LLM-generated per run, so an old run's numbers can't be mixed with a new
backend's numbers.

Rejected: a standalone ad-hoc script hitting the server directly. It would
duplicate corpus-chunking, query-gen, and recall/MRR scoring that
`embed-bench` already has tested and working, for no benefit.

## Scope

**In scope:**
- `python/embed-bench/backends/embed_mlx_server.py`
- Wiring in `run.py` to call it, but **only for the `bge-m3` model entry** —
  the server is single-model-per-process (currently configured for
  `mlx-community/bge-m3-mlx-8bit`), so this backend is meaningless for
  `qwen3-embedding-0.6b` / `nomic-embed-text-v1.5`. No generic
  skip-with-reason mechanism: the call is a plain
  `if model_name == "bge-m3":` conditional, and the other two models simply
  get no `embed_mlx_server` row. `report.py` already renders whatever rows
  it's given (no fixed grid assumption), so this needs no report-side change.
- Fresh run against both existing corpora: `docs/` (repo docs) and
  `/Users/huangziyu/proj/study-news/content` (Obsidian vault), each in one
  `run.py` invocation so `lmstudio`/`mlx_native`/`embed_mlx_server` share the
  same generated query set.
- Output: `python/embed-bench/results/repo-docs-server-check/report.md` and
  `python/embed-bench/results/study-news-server-check/report.md`, matching the
  existing per-corpus results-dir naming pattern
  (`results/<corpus>-<variant>/report.md`).
- Reading the resulting report and recording the comparison conclusion
  (matches raw `mlx_native` → gap is inherited, close the question; worse than
  raw `mlx_native` → real bug, scope a follow-up).

**Out of scope:**
- Fixing the recall gap itself. This benchmark only determines whether there
  IS a Swift-specific bug to fix — actual root-causing/fixing is a follow-up
  if the numbers show one.
- llama.cpp retesting (already decided against in Phase 0's wrap-up).
- Load/concurrency/latency testing (deferred — separate, lower-priority item
  from today's brainstorming).
- Formalizing today's functional curl checks into a saved test suite
  (deferred — separate item from today's brainstorming).
- Any change to `swift/embed-mlx-server` itself. This spec only adds a
  benchmark backend to the Python harness.

## Architecture

```
python/embed-bench/backends/embed_mlx_server.py
  BASE_URL = "http://127.0.0.1:8090/v1"
  is_available() -> bool        # raw TCP connect-and-close to 127.0.0.1:8090,
                                 # no HTTP call — the server has no /v1/models
                                 # or health route (documented limitation), so
                                 # a lightweight probe like lmstudio.py's isn't
                                 # available; a socket connect avoids
                                 # triggering real inference just to check
                                 # liveness.
  embed_batch(texts) -> list[list[float]]
                                 # POST /v1/embeddings, same request/response
                                 # shape as lmstudio.embed_batch — the "model"
                                 # field is accepted but ignored server-side,
                                 # so any placeholder string is fine.
```

`run.py`'s per-model loop gets one additional conditional block alongside the
existing `lmstudio`/`llamacpp`/`mlx_native` ones, gated on
`model_name == "bge-m3"`.

## Data flow

`run.py` → (for the `bge-m3` model only) `embed_mlx_server.embed_batch(texts)`
→ HTTP POST `/v1/embeddings` on the already-running launchd service → response
parsed into `[[float]]` vectors → same `rank_by_cosine_similarity` /
`recall_at_k` / `mean_reciprocal_rank` scoring already used for the other three
backends → merged into the same `rows` list → `write_report` produces one
`report.md` / `results.json` per corpus with all backends side by side.

## Error handling

Matches the existing three backends' pattern exactly: `run.py`'s `_run_combo`
already wraps each backend call in `try/except`, marking the row
`not tested` with the exception repr as `reason` on failure, so no new error
handling is needed inside `embed_mlx_server.py` itself beyond letting
exceptions propagate naturally (a non-2xx response or connection error from
`urllib.request` raises, same as `lmstudio.py`).

## Testing

No new unit test file — `lmstudio.py` and `llamacpp.py`, the two existing
backends with the same "thin HTTP client" shape, have no dedicated unit tests
either (only `corpus.py`/`metrics.py` are unit-tested in this harness). This
follows that established precedent rather than introducing an inconsistent
new one.

Validation is the benchmark run itself: a successful `run.py` invocation
against both corpora, producing non-`not tested` rows for `embed_mlx_server` /
`bge-m3`, is the test.
