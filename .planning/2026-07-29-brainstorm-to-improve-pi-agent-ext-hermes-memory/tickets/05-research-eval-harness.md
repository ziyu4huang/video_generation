# 05 — Remnic eval/bench harness: adopt a retrieval-quality eval?

type: research
blocked by: —

## Question

Does **Remnic** carry a memory/retrieval-quality eval or benchmark worth porting
to hermes — so that "prioritized" in this effort's spec is **evidence-backed**
rather than vibes?

Study the local clone: `evals/`, `benchmarks/`, the `bench` and `bench-ui`
packages, and any harness under `src/`. Also note `scripts/`.

Map, concretely:

1. **What it measures** — recall@k? precision? correctness-propagation (the
  Relay "mission receipt")? latency? token cost?
2. **How it runs** — fixtures vs live; how heavy the deps are; whether it needs
  a model in the loop (cost) or is deterministic.
3. **Portability** — can a *slim* version run against hermes's
  `MemoryRepository` / `SessionRepository` interfaces
  (`src/store/repository.ts`) to score hermes before/after a proposed
  improvement?

Then the recommendation (fed into the spec, ticket 09, not decided here):

- Should hermes adopt a lightweight retrieval-quality eval as part of this
  improvement effort, so each candidate improvement (tickets 06–08) can be scored
  before it's recommended? If yes, sketch the minimal eval shape (no heavy deps,
  no mandatory live-model).

## Resolution

_Closed (research) — `remnic_research_fanout` workflow, 2026-07-29. Findings arm the spec (ticket 09) on the eval recommendation._

### TL;DR

Remnic ships **two** eval systems. The older `evals/` is a clean, dependency-light harness with a tiny `MemorySystem` contract and pure-Function scorers (recall@k, precision@k, F1, ROUGE-L, contains-answer, LLM-judge). The newer `packages/bench` (`@remnic/bench`) is a production-grade suite (~30 benchmarks) adding integrity/provenance, token+cost accounting, an MCP adapter, and a correction-uptake benchmark (`memcorrect`) that maps directly onto hermes's correction-detector. **The scorers, the `MemorySystem` adapter shape, the cost schema, and the deterministic in-repo fixtures are highly portable.** What does **not** port is benchmarks that call `@remnic/core` ranking functions directly, and benchmarks that need a live LLM/QMD daemon. Hermes's `MemoryRepository`/`SessionRepository` seam is already shaped to satisfy the adapter contract.

### 1. WHAT IT MEASURES

All five families are present, spread across two systems:

| Family | Where |
|---|---|
| **Recall@k** | `evals/scorer.ts:recallAtK()`; `bench/src/scorer.ts`; dimension `memory_recall_at_k` (sealed qrels) |
| **Precision@k** | `bench/src/scorer.ts:precisionAtK()`; `memory_precision_at_k` |
| **F1 / ROUGE-L / exact / contains** | `evals/scorer.ts` (frequency-aware F1, LCS ROUGE-L); bench mirror |
| **Latency** | per-task `latencyMs`; aggregates `totalLatencyMs`, `meanQueryLatencyMs`; coding-graph harness p50/p95 |
| **Token cost** | per-task `tokens{input,output}` + `cost{totalTokens,inputTokens,outputTokens,estimatedCostUsd,...}` |
| **LLM-judge (optional)** | `llmJudgeScore()` returns `-1` when no judge; bench `BenchJudge` |
| **Correction propagation** | `memcorrect` — scores **uptake, non-resurrection (stale-memory harm), collateral, scope-precision, false-apply, reassertion, uptake-latency**. Directly aligned with hermes `correctedTo` + `correction-detector.ts` |

`packages/bench/src/memory-evals.ts` defines a **portable 8-dimension taxonomy** across 5 categories (`context-efficiency`, `retrieval-quality`, `boundary-respect`, `action-confidence`, `personalization`) — a ready-made rubric hermes could adopt as the *labels* for what an eval should cover.

**`RESULTS.md` headline numbers are explicitly flagged invalid** (scorer bug let F1 exceed 1.0). Treat published numbers as untrustworthy; the *harness* is the valuable artifact, not the scores.

### 2. HOW IT RUNS

**Deterministic, no-model paths exist and are first-class:** `coding-recall`, `procedural-recall`, `retrieval-direct-answer` runners each state "deterministic — no LLM, no storage, runs in CI," calling **pure functions from `@remnic/core`** over in-repo synthetic fixtures. `memcorrect` runs hermetically with a `PromptOnlyBaselineAdapter` default — green with no orchestrator. `evals/` offers `createLightweightAdapter()` — LCM + FTS5 only, deterministic summarizer (truncation), no external services.

**Live-model paths (heavy):** full-stack `evals` adapter needs an OpenAI key + the **QMD daemon** (extraction timeout 35s); `--judge` adds ~15s/question; bench `BenchResponder`/`BenchJudge` track tokens + `estimatedCostUsd`.

**Fixtures vs live datasets:** Remnic-internal benchmarks ship **synthetic fixtures in-repo** (deterministic); published benchmarks (LongMemEval, LoCoMo, AMA-Bench, AMemGym, MemoryArena, BEAM, PersonaMem, MemBench, MemoryAgentBench) require **HuggingFace download** (gitignored at runtime).

**Deps (`packages/bench/package.json`):** `@modelcontextprotocol/sdk`, `@remnic/coding-graph`, `@remnic/core`, `hyparquet`, `yaml`, `zod`. MCP SDK is the only non-trivial runtime dep; **no CUDA, no embedding server, no GPU** — the whole suite is Node-only. ("3090" is a runtime *profile name*, not a hard requirement.)

### 3. PORTABILITY onto hermes's repository seam

Hermes's `src/store/repository.ts` already exposes a backend-neutral surface mapping cleanly onto the bench `MemorySystem`/`BenchMemoryAdapter` contract:

| Bench adapter op | Hermes method |
|---|---|
| `store(sessionId, msgs)` | `addMemory()` / `syncMemoryEntry()` (+ `indexSession()`) |
| `recall(query, ...)` | `searchMemories(query, opts)` + `searchSessions()` |
| `search(query, limit)` | `searchMemories()` / `searchSessions()` |
| `correct(...)` | `replaceSyncedMemories()` / `removeSyncedMemories()` — hermes *already models corrections* (`correctedTo`, `correction-detector.ts`) |
| `reset()` | drop the temp `BackendBundle` (fresh `init()`) |

A **slim hermes adapter (~100 LOC)** over `MemoryRepository`+`SessionRepository` is straightforward — **no MCP server, no graph, no LLM required** for the deterministic fixtures. Cleaner than the `mcp-memory-adapter.ts` route (hermes is a Pi extension, not an MCP server).

**Direct lift blocked by one coupling:** the slim deterministic benchmarks import pure ranking/intent functions from `@remnic/core` that don't exist in hermes, so fixtures don't run as-is — but the **scorers, cost schema, integrity/provenance shell, and adapter contract lift cleanly.**

### Recommendation (arms the spec)

**YES — hermes should adopt a lightweight retrieval-quality eval as part of this effort.** Without it, every candidate improvement (graph ranker, recall-budget tier, consolidation change) is a vibes call. _"Agent memory without evals is vibes with a database"_ (`bench/src/memory-evals.ts`).

**Minimal eval shape for hermes (no heavy deps, no mandatory live-model):**
1. **Adapter (~100 LOC):** implement the `MemorySystem` contract over `MemoryRepository`+`SessionRepository` (store->addMemory/indexSession; recall/search->searchMemories+searchSessions; correct->replaceSyncedMemories; reset->fresh BackendBundle).
2. **Scorers (lift verbatim):** `recallAtK`, `precisionAtK`, `f1Score`, `rougeL`, `containsAnswer`, `exactMatch`, `aggregateScores`, `timed` from `evals/scorer.ts` (MIT, pure functions, zero deps).
3. **Two deterministic fixtures first** (no model, `bun test`): **retrieval precision/recall over a seeded corpus** (~20-50 query/expected-id cases with sealed qrels + SHA-256); **mini-memcorrect** (~15 scenarios: store old fact -> apply correction -> probe `correctedTo` surfaces, old absent) scoring uptake + stale-harm. Maps 1:1 onto hermes's correction path.
4. **Cost + latency envelope always on:** per-task `latencyMs`, `tokens{input,output}` (0 for deterministic), aggregate `meanQueryLatencyMs`.
5. **Provenance (steal the idea):** stamp every result with hermes version + git SHA + fixture hash — makes before/after comparisons trustworthy.
6. **LLM-judge strictly optional:** `judge?: LlmJudge` pattern — runs only when configured, returns `-1` otherwise. Never block CI on it.
7. **Defer:** published-dataset benchmarks (LongMemEval etc.), MCP adapter, full integrity/repro-manifest, coding-graph latency harness.

Gives every later verdict ticket a numeric delta (recall@5, precision@5, uptake%, stale-harm%, mean latency) to anchor go/no-go.

### Portability verdict

- **Ports onto hermes spine (MD=truth, SQLite=mirror) with low effort:** the `MemorySystem`/`BenchMemoryAdapter` contract; pure-function scorers; cost+latency schema; optional-LLM-judge pattern; the 8-dimension retrieval-quality taxonomy as a labeling rubric; sealed-qrels + git-SHA provenance idea.
- **Ports as design inspiration, needs hermes-native reimplementation:** the two slim deterministic benchmark *shapes* — fixtures rebuilt against hermes categories + two-tier scope, not `@remnic/core` rankers.
- **Needs a new substrate (out of scope here):** published-dataset benchmarks (HF downloads + live model); full-stack evals adapter (QMD daemon); coding-graph latency harness.
- **CUDA/heavy-dep flag:** none of the portable surface needs a GPU/embedding server; clean for Apple-Silicon/MLX.
