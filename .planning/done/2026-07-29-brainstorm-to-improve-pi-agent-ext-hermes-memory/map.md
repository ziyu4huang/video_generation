# Map — improve pi-agent-ext-hermes-memory by learning from Remnic

> **✅ COMPLETE (2026-07-29)** — all 9 tickets resolved; destination spec at [spec.md](spec.md); handed to **writing-plans**.

## Destination

A **prioritized, Pi-native improvement spec** for `pi-agent-ext-hermes-memory` —
derived from studying **Remnic**'s stronger memory mechanisms (hybrid retrieval,
belief-ledger/supersession, extraction/distillation loop, eval harness) and
scoped to what ports cleanly onto hermes's **MD-source-of-truth + SQLite spine**
under the **no-CUDA / MLX-only / Apple-Silicon** constraint.

The spec ranks candidate improvements with per-item port-design sketches and
hands off to **Superpowers writing-plans**. This effort produces **decisions /
spec only — no code** (plan-don't-do). When the spec lands, the map is done.

## Notes

**Domain.** Cross-pollinating ideas from a much larger, cross-agent memory
platform (Remnic) into a focused, Pi-specific, heavily-customized memory fork
(hermes). Hermes is the thing being improved; Remnic is the thing being learned
from — not adopted wholesale.

**Skills every session should consult.**
- `grilling` — every HITL ticket is a one-question-at-a-time grill.
- `domain-modeling` — hermes's ubiquitous language lives in
  `bun-apps/pi-agent-ext-hermes-memory/CONTEXT.md` (the five stores, two-tier
  scoping, policy-only mode, the learning loop, content scanning). Treat it as
  the glossary; speak its terms.
- `writing-plans` — the consumer of this map's destination spec.

**Repos (all local).**
- **Target (being improved):** `bun-apps/pi-agent-ext-hermes-memory/` — vendored,
  customized fork. `CONTEXT.md` = glossary.
- **Upstream (reference):** `/Users/huangziyu/proj/pi-ext-hermes-memory` =
  published `pi-hermes-memory@0.9.1` (`chandra447/pi-hermes-memory`).
- **Source to learn from:** `/Users/huangziyu/proj/pi-ext-remnic-memory` =
  **Remnic v9.35.4** (`joshuaswarren/remnic`) — turborepo, 36 packages. Research
  tickets read this **local clone** (not the web).

**Standing preferences for this effort.**
- Conversation in zh-TW; all written artifacts in English.
- **Plan, don't do** — this effort ships a spec, not code. Override only if the
  human explicitly says otherwise.
- **Hard scope:** Pi-only (no cross-agent platform ambition) + **keep hermes's
  store spine** (Markdown = source of truth, SQLite = searchable mirror). The
  spine is *extensible* — a ticket may propose adding a vector or graph layer
  onto it, but not replacing it.
- **Portability governor:** no CUDA, SDPA only, MLX-native (`bfloat16`), Apple
  Silicon MPS. Any candidate that needs a CUDA/GPU embedding server or a heavy
  external dep is suspect; prefer MLX-local or API-with-cost-note.

**Concurrency.** Last-write-wins (ADR-0005); this dedicated dated effort dir
isolates concurrent sessions by default.

## Decisions so far

- [01 — Ranking criteria](tickets/01-ranking-criteria.md) — score on retrieval-quality gain × Pi-architecture fit; hard-gate on effort (L→defer) and token-cost (ceiling pinned in 08); tiebreak on fit-with-hermes-strengths. Net: favor high-gain, cheap-to-port, token-neutral improvements. Gates defer, not kill.
- [02 — Remnic retrieval stack](tickets/02-research-retrieval-stack.md) — Remnic's scoring / provenance / LLM-as-judge rerank / in-memory Personalized-PageRank graph port onto the MD+SQLite-FTS5 spine as **pure `memory_search` post-processing**; only the **vector layer** needs a new substrate (`sqlite-vec` + MLX-local or host-injected embeddings; API opt-in). QMD binary, LanceDB, Meilisearch, Orama, SurrealDB-for-graph all OUT.
- [03 — Remnic belief-ledger / Relay supersession](tickets/03-research-belief-ledger-relay.md) — minimal port = MD-frontmatter + SQLite columns (`status`/`supersedes`/`supersededBy`/`parentIds`/`evidence[]`) + a `memory_supersede` tool + a post-correction recall probe. **Append-only, no platform rewrite, no new substrate.** The 4-role mission runner, Mission Control UI, and cross-agent propagation all OUT.
- [04 — Remnic extraction & context-injection loop](tickets/04-research-extraction-loop.md) — the **extraction side** ports well (SmartBuffer high-signal trigger, typed distillation + confidence rubric, verbatim-quote grounding, extraction-judge gate, scope tagging). The **injection side** fights the policy-only ethos — stay policy-only; borrow only the dedupe-keyed, opt-in "policy+hint" nudge, not Remnic's 12k-char-per-query auto-push.
- [05 — Remnic eval/bench harness](tickets/05-research-eval-harness.md) — recommendation: **adopt a lightweight eval.** ~100-LOC `MemorySystem` adapter over `MemoryRepository`/`SessionRepository` + verbatim-lifted pure scorers (recall@k/precision@k/F1/ROUGE-L) + two deterministic fixtures (seeded-corpus retrieval; mini-`memcorrect` uptake/stale-harm). No heavy deps, LLM-judge strictly optional.
- [06 — Verdict: retrieval](tickets/06-verdict-retrieval.md) — **IN** (ranked worth > provenance > rerank > boost; all substrate-free, pass gates); **DEFER phase-2** graph (edge-extractor effort) + vector (`sqlite-vec`+MLX, eval-gated, rides parallel effort T04 sync path); **OUT** QMD/Lance/Meili/Orama/SurrealDB. Worth-counters = only read-side-justified DB column; provenance stays frontmatter. All compatible with single-DB+project-field model.
- [07 — Verdict: belief/supersession](tickets/07-verdict-belief-supersession.md) — **Partial IN**: versioned append-only supersession (status+lineage frontmatter + SQLite mirror cols, `memory_search` defaults active) + `memory_supersede` tool (reuses 06's `sources[]` for evidence, file preserved) + post-supersession verification probe + consolidation-lineage-preserving coupling. Trigger on failure/correction first (mechanism category-agnostic). OUT: Full belief-ledger (Brier/stance) + cross-agent Relay platform. Fixes hermes's most-harmful stale-memory failure, no substrate.
- [08 — Verdict: extraction/distillation + token gate](tickets/08-verdict-extraction-loop.md) — **IN** (upgrade existing loop): event-driven trigger (fire on `correctionDetection`/`errorCapture`), typed+quote-grounded distillation (reuse 06 `sources[]`), extraction-judge gate (reuse `llmModelOverride` + 06 judge pattern), scope tagging. **Injection policy-only + opt-in ≤500t hint** (off by default). **Token gate pinned**: first-turn 0 / opt-in hint ≤500t / extraction+rerank write-query-side, cacheable, small-model OK. OUT: auto-inject-every-query, cold-builder, X-ray observability.
- [09 — Assemble spec](tickets/09-assemble-improvement-spec.md) — **spec.md written** (this effort dir). Phased IN list (Tier 1: memory-worth + provenance `sources[]` + belief/supersession → Tier 2: distillation + reranker + boost + event-trigger → Tier 3: opt-in ≤500t hint); eval adopted; out-of-scope justified; phase-2 fog named. Reconciled with current `config.ts` (post-rebase) + parallel effort `2026-07-29-persistent-to-planning` (T04/T05 open = write-path dep). **Closes the map.** Handoff: plan Tier 1 first; gate graph/vector on the eval-measured gap.

## Not yet specified

<!-- fog toward the destination; graduates as the frontier advances -->

**All fog graduated (map complete).** The four patches resolved as follows:

- **embedding source + vector/graph substrate + reranker** → decided in [06](tickets/06-verdict-retrieval.md): LLM-judge rerank **IN** (judge pattern); graph + vector **DEFER phase-2** (effort gate + eval-gated; MLX-local preferred). See spec §6.
- **token-cost ceiling** → **pinned in [08](tickets/08-verdict-extraction-loop.md)**: first-turn 0 / opt-in hint ≤500t / extraction+rerank write-query-side, cacheable. See spec §1.
- **specific MLX sentence-embedding model pick** → the one execution detail deferred to writing-planning (spec §6); not a map decision.

## Out of scope

<!-- work consciously ruled beyond this destination; never graduates -->

- **Cross-agent shared store / Remnic convergence.** Becoming a node in Remnic's
  cross-agent store (via its `plugin-pi`), or sharing one store across Claude
  Code/Codex/Cursor/etc. — Pi-only scope rules it out. The spec should briefly
  justify the ruling.
- **Markdown+frontmatter as the sole store model.** Replacing hermes's
  MD-source-of-truth + SQLite with Remnic's "every memory is a plain MD file,
  no DB" model — the keep-store-spine decision rules it out. Spec to confirm.
- **Capture subsystems.** Remnic's `capture-audio`, `capture-screen`,
  `capture-native-darwin-*` (hardware capture) — not an agent-memory concern for
  Pi.
- **Connectors / importers.** Remnic's `connector-*` (Bee, Fireflies, Granola,
  Limitless, Omi, Replit, WeClone) and `import-*` (ChatGPT, Claude, Gemini,
  mem0, supermemory, weclone) — cross-source ingestion, Pi-only rules out.

---

> **ABSORBED-BY `2026-08-08-knowledge-pipeline`** (2026-08-08 unification). Embed/backend decisions (ChromaDB rejected; sqlite-vec + SurrealDB-for-graph) feed canonical ticket 04. This effort's drift tickets (decisions already in Decisions-so-far) to be closed citing canonical ticket 04. See `.planning/2026-08-08-knowledge-pipeline/map.md`.
