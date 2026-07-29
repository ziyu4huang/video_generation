# Improvement spec — `pi-agent-ext-hermes-memory` (Pi-native, learned from Remnic)

_Status: complete. Closes the wayfinder map `2026-07-29-brainstorm-to-improve-pi-agent-ext-hermes-memory` (all 9 tickets resolved). Hands off to **Superpowers writing-plans**. This effort is **plan-don't-do** — decisions/spec only, no code._

---

## 0. One-line handoff to writing-plans

> **Plan Tier 1 first** — memory-worth scoring **and** the provenance `sources[]` frontmatter (highest-ranked **and** foundational: every downstream item reuses `sources[]`), then belief/supersession; stand up the eval alongside; gate the phase-2 graph/vector substrate on the measured retrieval gap.

---

## 1. Ranking model (from [01](tickets/01-ranking-criteria.md))

**Score** = retrieval-quality gain × Pi-architecture fit.
**Hard gates** (defer, not kill): effort (**L → defer**); token-cost ceiling — **0 tokens auto-injected at first turn / opt-in hint ≤500 tokens / extraction+rerank LLM off the first-turn path** (pinned in [08](tickets/08-verdict-extraction-loop.md)).
**Tiebreak**: fit-with-hermes-strengths.
**Phasing** below is driven by the score **and** by dependency (foundational seams land first).

---

## 2. Ranked, phased improvement list (the IN items)

Sourced from [06 retrieval](tickets/06-verdict-retrieval.md), [07 belief/supersession](tickets/07-verdict-belief-supersession.md), [08 extraction](tickets/08-verdict-extraction-loop.md). Effort: S / M / L.

### Tier 1 — ship first (cheap + high-value + foundational)

| # | Item | Verdict | Effort | Depends on | Port-design (gist → see ticket) |
|---|---|---|---|---|---|
| 1 | **Memory-worth scoring** | 06 | S | — | Frontmatter `mw_success`/`mw_fail`; query-time multiplier `score *= p_success/0.5`, `p_success=(s+1)/(s+f+2)` (Laplace), uninstrumented→1.0. Counters are read-side → **DB columns**; MD stays source-of-truth (sync mirrors). Trigger on session outcome. |
| 2 | **Provenance `sources[]` frontmatter** | 06 | S | — | `sources[]` `{kind, locator, capture}` + `provenance` enum. **Frontmatter only, no DB column** (not read at query time). `verified` requires a surviving source. **Foundational — 07 + 08 reuse this field.** |
| 3 | **Belief/supersession** (mechanism + tool + probe + consolidation coupling) | 07 | M | #2 | `status`(active\|superseded)+`supersedes`/`supersededBy`/`parentIds[]` frontmatter + SQLite mirror cols; `memory_search` defaults `active`. **`memory_supersede` tool** writes linked correction + lineage, flips prior→superseded (**file preserved**), seals audit; evidence reuses **#2's `sources[]`**. **Verification probe**: internal recall asserts replacement-present + prior-absent. **Consolidation coupling**: merge within a status, preserve lineage. Trigger on `failure`/`correction` first (mechanism category-agnostic). Fixes hermes's most-harmful stale-memory failure. |

### Tier 2 — distillation + retrieval quality (medium effort, high gain)

| # | Item | Verdict | Effort | Depends on | Port-design (gist → see ticket) |
|---|---|---|---|---|---|
| 4 | **Typed + quote-grounded distillation** | 08 | M | #2 | Upgrade background-review prompt: category-typed entries grounded in **verbatim session quotes** via **#2's `sources[]`** (kind=quote). Reuses `llmModelOverride`. |
| 5 | **Extraction-judge gate** | 08 | M | #4 | Judge step (reuse `llmModelOverride`/spawnSubagent — **same pattern as #6**) scores each candidate 0–100 (relevance/specificity/non-redundancy); drop < `extractionJudgeThreshold`. Write-side. |
| 6 | **LLM-judge reranker** | 06 | M | — | Post-FTS in `memory_search`: top-K (~20) → one `spawnSubagent`/host-LLM JSON 0–100 score → sort → top-N; TTL cache keyed by (query, candidate-set); noop fallback. Config `memoryRerank:"off"\|"llm"`. **Pair with #5 — one judge utility.** |
| 7 | **Boost multipliers + degradation-aware search** | 06 | S–M | — | Recency/access/importance multipliers (pure, post-query) + `reportSearchDegradation` observability. |
| 8 | **Event-driven extraction trigger + scope tagging** | 08 | S | #4 | Fire extraction when `correctionDetection`/`errorCapture` signals (no new detector). Tag entries session/project/global (reuse target routing + `projectsMemoryDir`; **rides parallel effort T04**). |

### Tier 3 — opt-in (off by default)

| # | Item | Verdict | Effort | Depends on | Port-design (gist → see ticket) |
|---|---|---|---|---|---|
| 9 | **Opt-in dedupe-keyed ≤500-token hint** | 08 | S–M | — | One-line hint surfaced on a dedupe-key match; `hintInjectionEnabled:false`, `hintInjectionMaxTokens:500`. Default `policy-only` unchanged (0 first-turn tokens). The only injection concession. |

**Cross-cutting (build once, reuse everywhere):** `sources[]` (#2, used by #3/#4); the **LLM judge utility** (#5/#6); `llmModelOverride`/`llmThinkingOverride` (the existing LLM seam for #4/#5/#6); the single-DB + `project` field model (all additions must be compatible).

---

## 3. Eval ([05](tickets/05-research-eval-harness.md))

**Adopt a lightweight eval** alongside Tier 1–2: ~100-LOC `MemorySystem` adapter over `MemoryRepository`/`SessionRepository` + verbatim-lifted pure scorers (**recall@k / precision@k / F1 / ROUGE-L**) + two deterministic fixtures (seeded-corpus retrieval; mini-`memcorrect` uptake/stale-harm). No heavy deps; LLM-judge strictly optional.

**Use it to:** (a) baseline Tier 1–2 retrieval quality, and (b) **gate the phase-2 graph/vector substrate** on the measured gap FTS5+rerank leaves.

⚠️ **Caveat:** Remnic's `RESULTS.md` headline numbers are **invalid** (a scorer bug let F1 > 1.0). The **harness is the artifact, not the scores** — port the harness, ignore their published numbers.

---

## 4. Dependencies & risks (for writing-plans)

- **Parallel effort `2026-07-29-persistent-to-planning`** (now in-tree after rebase): **T01/T02/T03 closed** (`projectsMemoryDir` config knob, single-DB + tag-on-index, no migration); **T04 (project-aware write-path + `sync-markdown-memories` second-source) + T05 still OPEN.** Several port-designs ride T04's sync path: #8 scope-tagged writes, #3 consolidation-lineage coupling, and both phase-2 substrates (graph edge-extraction, vector embedding-at-index). **Sequence Tier 2 / phase-2 after or alongside T04.**
- **Naming:** the actual config knob is **`projectsMemoryDir`** (plural), default `DEFAULT_PROJECTS_MEMORY_DIR` — not `projectMemoryDir`.
- **`dbBackend: sqlite | surrealdb` already exists** — "SurrealDB off" in 06 means **no SurrealDB *graph layer*** (PPR needs none), not "no SurrealDB backend."
- **Consolidation child guard:** `isConsolidatingChild()` (config.ts) forces `autoConsolidate=false` + `vault-offload` in the consolidator child. #3's lineage-preserving consolidation must respect this guard (never recurse, preserve links within the child's single pass).
- **Read-side columns vs frontmatter:** `status`/lineage (#3) and worth-counters (#1) are read-side-justified DB columns; provenance (#2) stays frontmatter-only. Consistent with the parallel effort's "no DB column without a read-side need."

---

## 5. Out of scope (justifications)

- **Cross-agent shared store / Remnic convergence** — becoming a node in Remnic's cross-agent store (its `plugin-pi`) or sharing one store across Claude Code/Codex/Cursor. **Pi-only scope.**
- **Markdown-only store (no DB)** — replacing hermes's MD-source-of-truth + SQLite with Remnic's "every memory is a plain MD file" model. **Keep-store-spine decision.**
- **Capture subsystems** (`capture-audio`/`capture-screen`/`capture-native-darwin-*`) — hardware capture, not agent-memory.
- **Connectors / importers** (`connector-*`: Bee/Fireflies/Granola/Limitless/Omi/Replit/WeClone; `import-*`: ChatGPT/Claude/Gemini/mem0/supermemory) — cross-source ingestion. **Pi-only.**
- **Full belief-ledger** (Brier predictions, stance, confidence calibration, Socratic challenge) — prediction-calibration isn't hermes's domain; heavy, marginal.
- **Cross-agent Relay** (4-role runner, Mission Control, namespace store, credit/isolation, clean-room judge) — platform, Linux/Codex-only.
- **Remnic auto-inject-every-query** (~12k chars/query) — breaks the low-first-turn-token ethos; token gate forbids.
- **QMD binary / LanceDB / Meilisearch / Orama / SurrealDB-for-graph** — GPU native / Arrow bindings / server process / duplicates FTS5 / PPR needs no graph store.

---

## 6. Deferred fog → named phase-2 follow-ups

- **Vector / hybrid layer** — `sqlite-vec` `vec0` in the single DB + embeddings (MLX-local preferred via host-injected seam, `--offline`, bfloat16; API `text-embedding-3-small` opt-in). **Eval-gated** (§3) + needs the model pick below. Query = hybrid FTS5+vector then the #6 reranker.
- **Graph recall** — in-memory Personalized PageRank over candidates + an edge extractor (links on shared entities/tags). Effort-gated.
- **Reranker/vector feasibility** — confirmed feasible (sqlite-vec + MLX-local satisfy the no-CUDA governor); deferred on eval evidence, not capability.
- **Specific MLX sentence-embedding model pick** — the one genuinely open execution detail; resolved in planning, not on the map.
- **Extraction X-ray observability** — nice-to-have diagnostic; not v1.

---

## 7. Provenance of this spec

Synthesized from the wayfinder map's resolved tickets: ranking [01], research [02–05], verdicts [06 retrieval / 07 belief / 08 extraction]. Reconciled with the now-current `pi-agent-ext-hermes-memory` (`config.ts` post-rebase) and the in-tree parallel effort `2026-07-29-persistent-to-planning`. Closing [09](tickets/09-assemble-improvement-spec.md) closes the map.
