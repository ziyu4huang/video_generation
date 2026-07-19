# Knowledge-Graph Improvement Plan

> **Planning doc — `plan/ecosystem-kg-review` cycle.** Research + design audit only.
> No `zk_*` / `obsidian_*` code shipped from this cycle. (A companion
> `ecosystem-review.md` was drafted on PR #333, but that PR was closed
> unmerged — the file is not on `main`.)
>
> **Goal:** turn "improve the knowledge graph" from a vague ambition into a
> ranked, measurable backlog — and force the semantic-blend question to be
> answered with data, not vibes. Clarify the vault-mind ↔ pi-obsidian boundary
> (semantic layer vs graph layer) so the next execution cycle doesn't blur them.

---

## TL;DR

- **vault-mind IS our semantic backend.** `obsidian_semantic_search` calls
  `VAULT_MIND_BASE_URL` (default `http://127.0.0.1:8000`) → vault-mind's
  FastAPI `/api/search` → ChromaDB (`all-MiniLM-L6-v2`, 384-dim). The two
  stacks are complementary, not competing. Our KG is **graph-first**;
  vault-mind is **vector-first**.
- **The spike confirmed one real gap:** vault-mind's `EnhancedMarkdownParser`
  extracts **9 structured-feature categories** (callouts, tasks, embeds, math,
  code blocks, tables, dataview, structure, link-stats) that our `zk_ingest`
  drops entirely. See §3 + `output/spike-vaultmind-vs-zkingest-parsing.json`.
  The gap is confined to *feature metadata*, not retrieval correctness — tags
  + the wiki-link graph already drive our graph-RAG.
- **The semantic-blend prior holds.** Re-confirmed from memory (iter-6,
  2026-07-05): 5 zh-TW queries vs 425 English cards, adversarial zero-overlap
  gate, mean relevance@4 **lexical+graph 0.332 vs semantic-lexical 0.100**,
  lexical wins 2/5. The standing conclusion — *"semantic-lexical has no
  measured regime where it wins outright — keep as diagnostic only"* — is
  intact. Any "add more semantic" proposal must re-prove a win before
  investment (proposal P3).
- **Per-section chunking is CONFIRMED not applicable** to our atomic-zettel
  model (proposal P5) — the wiki-link graph already captures structure.
- **Next-cycle pick-list:** (1) ~~re-run the semantic-blend measurement ONCE~~
  ✅ DONE — P3 CLOSED: iter-7 measured, lexical wins 4/5 (mean rel 0.770 vs
  semantic-lexical 0.466), semantic blend RETIRED from the default READ path;
  (2) ~~prototype carrying callout/task/embed frontmatter flags~~ ✅ DONE —
  P1 CLOSED (ship): additive keys + bounded callout ranking boost + callout
  surfacing shipped; the real surface has 0 callouts so the mechanism was
  proven deterministically (`scripts/p1-feature-measure.mjs`).

---

## 1. The two stacks at a glance

| Aspect | Our KG (`pi-knowledge-card` + `pi-obsidian`) | vault-mind (`../vault-mind/backend/`) |
|---|---|---|
| **Primary retrieval** | Graph (wiki-link edges + shared-tag cross-links) | Vector (ChromaDB cosine similarity) |
| **Unit of storage** | One atomic zettel card per record | One chunk per ~1000-char semantic boundary |
| **Ingest** | Deterministic (`zk_ingest`, no LLM) — 12-key `.knowledge.jsonl` → card | LLM-free parser → chunker → embedding |
| **Embedding model** | None (graph edges are the signal) | `all-MiniLM-L6-v2` (384-dim, sentence-transformers) |
| **Store** | Markdown files in an Obsidian vault | ChromaDB persistent client |
| **Obsidian parsing** | frontmatter + body (wikilinks **stripped** to prose) | `EnhancedMarkdownParser` — callouts, tasks, embeds, math, code, tables, dataview, heading/block refs, link density |
| **Metadata** | frontmatter (id/type/confidence/status/provenance) | `MetadataEnhancer` — content metrics, topic/content-type/purpose detection, search tags, change-detection fingerprint |
| **Health** | `graphHealth` (orphans/dead-links/MOC drift) + `healGraph` auto-heal | `collection_manager.get_collection_health` + job-queue reindex |
| **Language** | Bun/TypeScript | Python (FastAPI + ChromaDB + sentence-transformers) |
| **Coupling** | `obsidian_semantic_search` → vault-mind `/api/search` (graceful fallback if down) | standalone service; indexed by vault name |

The arrow that matters: **`obsidian_semantic_search` (ours) → vault-mind
`/api/search` (theirs)**. That is the one shared seam. It degrades gracefully
(`isError` if vault-mind is unreachable → `zk_ask` falls back to lexical). The
two layers are loosely coupled **by design** — any proposal that makes the
semantic layer a *hard* dependency is rejected (see P4).

---

## 2. Mechanism map — vault-mind → our KG surface

For each vault-mind mechanism: **(a) already shared**, **(b) adoptable** (an
idea worth a proposal), or **(c) not applicable** (rejected, with reason).

### (a) Already shared

| vault-mind mechanism | Our equivalent | Status |
|---|---|---|
| ChromaDB `/api/search` semantic query | `obsidian_semantic_search` tool (routes to it) | **Shared** — vault-mind IS our semantic backend |
| `MarkdownParser` frontmatter + wikilink extraction | `parseFrontmatter` in `pi-obsidian` | **Shared** — both parse Obsidian frontmatter |
| `collection_manager.get_collection_health` | `graphHealth` (dead-links/orphans/MOC-drift) | **Shared concept** — different scope (collection vs folder) |
| Local-first, no cloud | Local-first, no cloud | **Shared** — both run on-device |

### (b) Adoptable (ideas → proposals §4)

| vault-mind mechanism | What we'd borrow | Why |
|---|---|---|
| `EnhancedMarkdownParser` feature extraction (callouts, tasks, embeds, math, heading-refs, link density) | Carry feature **metadata** as optional zettel frontmatter flags | Enables feature-aware retrieval filtering + callout-text surfacing in `zk_ask` context (spike-validated gap; P1) |
| `MetadataEnhancer._generate_metadata_fingerprint` (md5 of significant fields) | A `content_hash` frontmatter key for fast unchanged-detection | Short-circuits the global re-write path in `ingestRecords` (P2) |
| `MetadataEnhancer._detect_content_type` / `_detect_document_purpose` | A `content_type` retrieval filter axis | Our `record_type` (lever/avoid/gotcha) is domain-better, but content_type adds a second axis (P1 sub-option) |
| `MetadataEnhancer` hierarchical-tag flattening (`a/b/c` → `a`, `a/b`, `a/b/c`) | Flatten nested tags in `retrieveRecords` matching | Better recall on hierarchical dimensions (P6) |
| `collection_manager` async job-queue reindex (pause/resume/cancel + progress) | File-watch-triggered re-ingest | Only matters at 10× scale; logged for completeness (P4 adjacent) |

### (c) Not applicable (rejected, with reason)

| vault-mind mechanism | Why we don't adopt |
|---|---|
| **Per-section chunking** (`TextChunker`, 1000-char + 200-overlap, semantic boundaries) | Our atomic-zettel model is **intentionally one-card-per-record**. Chunking would fragment the wiki-link edge graph — and the graph IS our structure signal. Validated by design intent (the convergence sink's value proposition is one canonical card per record). See P5. |
| **Python sentence-transformers / ChromaDB multi-collection** | We are Bun/TS; can't port. The vector layer is complementary (accessed via `obsidian_semantic_search`), not something to reimplement in-process. |
| **ChromaDB `where`-clause query filters** | `retrieveRecords` uses in-memory tag-set intersection — fast, deterministic, no external service dependency. No need for DB-side filters. |
| **FastAPI + WebSocket progress streaming** | Our ingest is a synchronous batch over hundreds of cards (sub-second). The async machinery is overhead we don't need at current scale. |

---

## 3. The spike — what vault-mind extracts that we drop

> Throwaway script: `output/spike-vaultmind-vs-zkingest-parsing.py`
> (sample: `output/spike-sample-note.md`, summary: `output/spike-vaultmind-vs-zkingest-parsing.json`).
> Run: `../vault-mind/.venv/bin/python output/spike-vaultmind-vs-zkingest-parsing.py`

**Claim tested:** *vault-mind's `EnhancedMarkdownParser` extracts structured
Obsidian metadata that our `zk_ingest` drops.*

**Result — CONFIRMED.** On a 1036-char sample note exercising all features,
vault-mind extracted **9 structured-feature categories**; our `zk_ingest`
captures **0** of them:

| Feature | vault-mind count | Our `zk_ingest` |
|---|---|---|
| callouts (`> [!type]`) | 2 | dropped |
| tasks (`- [x]`/`[ ]`/`[-]`) | 3 | dropped |
| embeds (`![[...]]`) | 1 | dropped |
| math blocks (`$...$`, `$$...$$`) | 2 | dropped |
| code blocks (fenced + lang) | 1 | dropped |
| tables (headers + rows) | 1 | dropped |
| structure (heading outline) | 1 | dropped |
| links (wikilinks + heading/block refs + md links + URLs) | 3 | **stripped to prose** ⚠ |
| link_stats (internal/external/outgoing counts + density) | 3 | dropped |

Our `zk_ingest` preserves: frontmatter keys, the detail body as plain prose,
and tags (harvested for cross-linking). Body `[[wikilinks]]` are stripped to
their display text — so they survive as *prose* but are **lost as graph edges**
from the body (the real edges come from the tag-harvest in `adaptAutoMemoryMarkdown`
and the shared-tag neighbour computation in `ingestRecords`).

**Scope caveat (important):** the gap only matters for **human-authored** vault
notes (`obsidian_distill` output, manual zettels). Our auto-generated cards
(from `.knowledge.jsonl`) are deterministic prose + frontmatter — they rarely
contain callouts/tasks/embeds. So P1 is scoped to the human-authored surface,
not the convergence sink.

---

## 4. Proposals — ranked

Each: **lever** (what moves), **effort** (S/M/L), **risk**, **proof metric**
(the number that would prove it), **verdict**.

### P1 — Carry richer Obsidian feature metadata in zettel frontmatter  ✅ **CLOSED (feature-aware-retrieval cycle, 2026-07-07)**

> **CLOSURE NOTE (feature-aware-retrieval cycle):** shipped the feature
> extractor + additive frontmatter keys + feature-aware ranking + callout
> surfacing. `zk_ingest`/`adaptAutoMemoryMarkdown` now detect callouts
> (`> [!warning|tip|…]`), tasks (`- [ ]`/`- [x]`), embeds (`![[…]]`), and
> fenced-code density via `extractFeatures()`, writing ADDITIVE keys
> (`has_callouts`, `callout_types`, `has_tasks`, `open_task_count`,
> `embed_count`, `code_block_lines`) — only when the source body has the
> feature, so feature-less records stay byte-identical (old cards validate +
> retrieve unchanged). `retrieveRecords` applies a bounded `+0.5` callout
> boost (tie-break only — applied after shared-tag count, before the id
> localeCompare; never displaces a strictly-more-on-tag card) and `formatDigest`
> lifts the callout headline into the digest line; `buildRagTask` (the `zk_ask`
> path) carries a Step-4 “surface callouts first” instruction.
>
> **Measurement:** the real human-authored surface carries **0 callouts / 0
> embeds / 1 task (a template)** across 32 human-authored + 429 converged cards
> (grep 2026-07-07), so the LLM-judge `relevance@4` harness would show a
> vacuous zero-delta — nothing to boost or lift. The mechanism was instead
> proven deterministically (`scripts/p1-feature-measure.mjs`) on a synthetic
> callout corpus, before/after: **rankLift** (a callout card that loses the id
> tie-break in baseline ranks ahead of its equal-tag prose competitor in post),
> **noDisplacement** (a strictly-better-tagged prose card stays #1 in both), and
> **surfacingDelta** (the `[!warning]` marker reaches the digest only in post).
> All three gates pass → **SHIP**.
>
> **Decision:** ship the additive keys always (harmless when dormant on the
> current callout-free corpus — ready for a future callout-bearing surface);
> ship the rank/surface levers (bounded, unit-tested, mechanism-proven). No
> semantic blend reopened (P3 stays CLOSED — feature metadata rides the
> existing graph+lexical stack, not vectors). Receipt:
> `output/p1-feature-measurements/measure-*.json`.
>
> **EMPIRICAL VALIDATION (real-retrieval-validation cycle, 2026-07-08).** The
> reopen condition below was met: 20 real callout-bearing cards were seeded
> into the convergence vault (from project gotchas/MEMORY/failure-lessons),
> a 25-query real eval set was built, and a DETERMINISTIC ablation was run
> (`scripts/real-retrieval-measure.mjs`, receipt
> `output/real-retrieval-measurements/measure-*.json`). **Result: the P1 callout
> boost is NEUTRAL — Δ = 0 (it flipped 0/25 rankings, withBoost 12/25 =
> withoutBoost 12/25).** At 20 callout cards in 449 (4.5% density) the bounded
> +0.5 tie-break almost never encounters a callout card that ties an equal-tag
> prose card AND matters for top-4. The **surfacing lever works** (60% of
> callout cards that hit top-4 had their callout headline lifted into the
> digest), so P1's value is in *surfacing*, not *ranking*. **Decision update:
> keep the boost dormant** (bounded, harmless, ready for higher density) **and
> keep the surfacing lever** (functional). The ranking boost is NOT removed —
> it costs nothing and activates automatically if callout density grows. Reopen
> the ranking-boost question only at >15% callout density (≈70+ callout cards).
>
> **Separate finding (not P1): the tag-based path has limited natural-language
> recall.** The deterministic `retrieveRecords` path (shared-tag matching, what
> `knowledge_query` uses) scored hit-rate@4 = **0.48** on real queries — natural
> words (“black”, “package-lock”) rarely match curated tags (“vae”, “bun”). A
> full-text proxy (query tokens in the expected card body — what `zk_ask`'s
> `obsidian_search` matches) scored **0.68**. This ~20pt gap is a property of
> the TAG path, NOT P1, and NOT a live `zk_ask` run — filed as candidate P7
> below (improve `knowledge_query` recall).

<details><summary>Original proposal (superseded by the closure above)</summary>

- **Lever:** `retrieveRecords` could filter "only cards with warnings" or rank
  callout-bearing cards higher; `zk_ask` context assembly could surface callout
  text (warnings/tips are often the highest-signal lines in a note).
- **Effort:** **M.** Add optional `has_callouts`, `callout_types`, `has_tasks`,
  `embeds` frontmatter keys during ingest of *human-authored* notes; thread
  them through `retrieveRecords` ranking + `zk_ask` context.
- **Risk:** **low.** Additive frontmatter; backward-compatible (old cards just
  lack the keys). Scoped to human-authored surface, not the deterministic sink.
- **Proof metric:** spike already proves the 9-category drop. Re-run the
  **queryCount-5 harness** (`retrieval-quality-self-improve.js` +
  `lexical-overlap-check.mjs`) with feature-flagged human-authored cards vs
  not, on a fixed 5-question set; relevance@4 must improve OR callout-aware
  context must change ≥1 answer quality rating to be worth the M.
- **Verdict:** **prototype next cycle** (pick-list #2). The spike de-risked the
  "is the gap real?" question; the harness answers "does it help retrieval?".

</details>

### P2 — Change-detection fingerprint for incremental re-ingest  *(Adopt, low urgency)*

- **Lever:** `ingestRecords` currently recomputes cross-links globally and
  detects unchanged cards by full content-string equality. A frontmatter
  `content_hash` (md5 of significant fields, like vault-mind's
  `_generate_metadata_fingerprint`) short-circuits unchanged detection without
  reading the file body.
- **Effort:** **S.**
- **Risk:** **low** (we already detect unchanged via equality; fingerprint is a
  faster path to the same result, not a behavior change).
- **Proof metric:** benchmark `ingestRecords` on a 500-card folder — wall-clock
  for a "no changes" re-ingest with vs without the fingerprint short-circuit.
  Must show **>30% speedup** to be worth the added frontmatter key.
- **Verdict:** **DEFER (steady-state).** At current scale (429 converged cards,
  2026-07-07) the global recompute is sub-second. **Reopen when:** the vault
  grows ~10× (≈4000+ cards) AND a benchmark shows the no-op re-ingest wall-clock
  exceeds the >30% speedup gate. Until then the fingerprint is unused
  frontmatter bloat.

### P3 — Re-confirm the semantic-blend measurement, then retire-or-invest  ✅ **CLOSED (iter-7, 2026-07-07)**

> **CLOSURE NOTE (semantic-closure cycle):** measured iter-7 on the current
> 425-card vault — clean run, 5/5 ranked, all semantic stages live. `default`
> (lexical+graph) mean relevance@4 **0.770** vs `semantic-lexical` **0.466**;
> lexical wins **4/5**. Semantic-lexical did NOT exceed the ≥0.05 gate (it was
> 0.304 worse). Cross-regime confirmation: iter-6 (zh-TW) was 0.332 vs 0.100.
> **Verdict: RETIRE** the semantic blend from `zk_ask`'s default READ path —
> done (see the `knowledge-card.ts` blend description + `zk-ask.ts` NOTE).
> Receipt: `output/iter7-receipt-2026-07-07T01-00-52.json`
> (history `2026-07-07T01-00-52.json`).
>
> **Harness sufficiency (gate A1):** the overlap-gate + controlled-corpus
> infrastructure is fully on `main` via PR #316 (commit `bb2477d5`):
> `workflows/lib/lexical-overlap-check.mjs`(+test), `scripts/controlled-corpus.mjs`,
> `scripts/iter4-measure.mjs`, and the hardened `retrieval-quality-self-improve.js`
> are all on `main` (6/7 files byte-identical to the superseded branches). The
> open retrieval PRs were stale aggregates of this same work — **#303, #307,
> #311 closed** (their distinctive content already landed via #316; #307's
> goal-readonly commits are carried by the still-open #308).
>
> **Suppression rule:** semantic-blend re-measurement requires a NEW corpus or
> regime (e.g. a 10× vault, or a different vault-mind embedding model), not a
> re-run on the current regime. A genuinely new regime legitimately re-opens
> this proposal.

- **The prior (re-confirmed from memory, 2026-07-05 iter-6):** 5 zh-TW queries
  vs **425 English knowledge-graph cards**, adversarial zero-lexical-overlap
  gate (`lexical-overlap-check.mjs`). Mean relevance@4:
  **`default` (lexical+graph) = 0.332 vs `semantic-lexical` = 0.100**. Lexical
  wins **2/5** outright. Standing conclusion in memory: *"semantic-lexical has
  no measured regime where it wins outright — keep as diagnostic only, not a
  recommendation. Graph expansion bridges concepts across languages better than
  semantic vectors alone."*
- **Why re-confirm:** the vault has changed since 2026-07-05 (more cards,
  different tag distribution). A single re-run on current state either
  **retires** the proposal definitively (expected) or surfaces a new regime
  worth a three-way experiment. The goal §5 explicitly forbids assuming
  embeddings improve graph-RAG by default.
- **Lever:** IF semantic wins a regime, `three-way` blend (0.4 semantic / 0.3
  lexical / 0.3 graph, already implemented + tested in `blend.test.ts`) could
  improve cross-source recall. If not, we stop spending attention on it.
- **Effort:** **S** (re-run the existing harness).
- **Risk:** **low** (measurement only; no code change).
- **Proof metric:** re-run `retrieval-quality-self-improve.js` on the current
  vault with the same 5-query adversarial set. Gate: semantic-lexical mean
  relevance@4 must **exceed** lexical+graph by ≥0.05 to justify any further
  semantic investment; otherwise **RETIRE** and update the `zk_ask` tool
  description's blend note to "measured-retired, diagnostic only".
- **Verdict:** **CLOSED — RETIRE (iter-7).** Lexical+graph wins 4/5 (mean rel
  0.770 vs 0.466); cross-regime with iter-6 (zh-TW, 0.332 vs 0.100). Semantic
  blends stay as `--blend` opt-in only. See closure note above +
  `output/iter7-receipt-2026-07-07T01-00-52.json`.

### P4 — Graph-health-aware re-indexing (sync semantic + graph layers)  *(Adopt, opt-in only)*

- **Lever:** after `healGraph` fixes the graph layer (prunes dead links,
  regenerates MOC), trigger a vault-mind reindex so the semantic layer
  (ChromaDB) reflects the same on-disk state. Currently the two layers can
  drift (graph healed, ChromaDB stale).
- **Effort:** **M.** Cross-process coordination: Bun `ingest`/`healGraph` →
  vault-mind FastAPI `reindex_collection` endpoint.
- **Risk:** **medium.** Auto-sync risks making the semantic layer a *hard*
  dependency. Mitigation: keep the sync **opt-in** (a flag), never required —
  `obsidian_semantic_search` must continue to degrade gracefully to lexical
  when vault-mind is down.
- **Proof metric:** after a `zk_ingest` run changing *N* cards, verify
  vault-mind's `collection_manager` `document_count` increments by *N* and a
  semantic query returns a new card within one reindex cycle (≤2s on current
  vault).
- **Verdict:** **COLLAPSED (P3 retired).** P3 (semantic blend) is CLOSED —
  RETIRED from the default READ path (iter-7: lexical wins 4/5). This proposal
  existed only to sync the semantic layer after `healGraph`; with semantic
  retired, there is no layer to sync. **Reopen only if:** P3 is legitimately
  re-opened by a NEW regime (10× vault OR a different vault-mind embedding
  model) AND semantic wins — then the sync becomes worth building (opt-in,
  never a hard dependency).

### P5 — Finer chunking (per-section)  *(DECISION: not applicable — do not adopt)*

- **vault-mind:** chunks by heading/section (1000 chars, 200 overlap, respects
  paragraph/sentence/code boundaries).
- **Our model:** one atomic card per record — **intentionally**.
- **Decision (not assumed):** chunking would fragment the wiki-link edge graph,
  and the graph IS our structure signal. The atomic-zettel + deterministic-
  convergence model is the convergence sink's whole value proposition (one
  canonical card per record, dedup'd by id, cross-linked by shared tags).
- **Verdict:** **CONFIRMED not applicable.** Logged for completeness so the
  question doesn't recur. The wiki-link graph already captures document
  structure at the right granularity for our use case.

### P6 — Search-friendly hierarchical-tag flattening  *(Adopt, likely low-value)*

- **Lever:** vault-mind's `MetadataEnhancer` flattens `a/b/c` → `a`, `a/b`,
  `a/b/c` so a search for `a` matches. Our `retrieveRecords` uses raw
  normalised tags.
- **Effort:** **S.**
- **Risk:** **low.**
- **Proof metric:** `grep` the convergence folder for `/` in frontmatter tags.
  If **<5%** of cards carry hierarchical tags, **drop** the proposal as
  low-value (our dimensions are already mostly flat: `flux2`, not
  `generation/flux2`).
- **Verdict:** **DROP (measured 2026-07-07).** A `grep` of the convergence
  folder shows **2 / 429 cards (0.4%)** carry a hierarchical (`/`-bearing) tag
  — far below the 5% reopen threshold. Our dimensions are flat (`flux2`, not
  `generation/flux2`); the flattening code would touch <1% of cards. **Reopen
  when:** hierarchical-tag rate exceeds 5% of the convergence folder.

### P7 — Improve `knowledge_query` natural-language recall (tag path → full-text fallback)  *(Candidate — zk_ask branch CLOSED 2026-07-08; tag-path-only)*

> **Surfaced by the real-retrieval-validation cycle (#356), zk_ask branch
> settled by the live-zk-ask-measure cycle (2026-07-08, receipt
> `output/live-zk-ask-measurements/measure-2026-07-08T14-27-04-881Z.json`).** The
> deterministic measurement showed `retrieveRecords` (the `knowledge_query` /
> `zk-query` path, shared-TAG matching) scores hit-rate@4 = **0.48** on real
> natural-language queries, while a full-text proxy (query tokens in the
> expected card body) scores **0.68**. Natural words (“the image comes out
> black”, “package-lock.json”) rarely match curated tags (“vae”, “bun”,
> “package-management”). This is a property of the TAG path, not of P1 (the
> callout boost was neutral, Δ=0).
>
> **zk_ask branch CLOSED (live receipt `measure-2026-07-08T14-27-04-881Z`).**
> The live `zk_ask --retrieve-only --blend default --top-k 4` run over the same
> 25-query eval set scored **hit-rate@4 = 0.64** (strict — expected card in the
> first-4 of the agent’s declared top-4; loose citation-at-any-depth = 0.68;
> mentioned-anywhere = 0.76; 0/25 failures). zk_ask clears the 0.5 reopen gate
> and beats the 0.48 tag-path baseline by +16pts — **the ~20pt recall gap is a
> property of the TAG path (`knowledge_query` / `retrieveRecords`), NOT zk_ask**
> (which uses `obsidian_search` full-text + graph). The flagship recall path is
> adequate. P7 is now a **tag-path-only candidate**, not a systemic one.

- **Lever:** when `knowledge_query` is given a natural-language query (no tags),
  its naive tokenizer (`toLowerCase → split on non-alphanumeric → top-10 words`)
  produces words that don’t match tags. Options: (a) route tag-less queries
  through `obsidian_search` (full-text) and feed those hits into the shared-tag
  ranking; (b) a query→tag inference step (map “black image” → `vae`); (c) hybrid
  (full-text OR shared-tag). **Lean (a)** — reuse pi-obsidian’s search.
- **Effort:** **M.** Plumbing `knowledge_query` to call `obsidian_search` when
  tags are sparse, then merge with `retrieveRecords`.
- **Risk:** **low-medium.** `knowledge_query` is the deterministic no-LLM digest;
  adding a search call couples it to the pi-obsidian index (already a hard dep).
- **Verdict:** **prototype when `knowledge_query` recall becomes a felt pain**
  (tag path only). The zk_ask reopen condition is CLOSED: it measured 0.64 ≥ 0.5,
  so the gap is path-specific, not systemic. `zk_ask` (full-text + graph) is the
  flagship recall path and serves the “answer my question” use case;
  `knowledge_query` is the digest/CLI tool. The 0.48 tag-path number is a
  BASELINE, not a regression. **Reopen (tag path) when:** a real agent session
  reports `knowledge_query` missing an obvious card (felt pain). The zk_ask
  branch stays closed unless a future retrieval change drops it below 0.5 on
  this eval set (re-runnable via `scripts/live-zk-ask-measure.mjs`).

### P8 — Typed-entity extraction + IDF-weighted cross-linking (SAG-inspired)  ✅ **SHIPPED (mechanism, opt-in — 2026-07-11)**

> **Origin:** study of `../SAG/` (Zleap-AI/SAG), a graph-retrieval RAG workbench
> whose core innovation is the **entity-event bipartite graph**: each chunk →
> ONE fused event + MULTIPLE *typed* entities, with multi-hop retrieval
> traversing entity→event→entity→event. SAG beats HippoRAG 2 by +11.16pp
> Recall@2 because its entities are **specific and content-grounded** — a query
> for "flux2" matches the *entity* flux2 (3 events), not the ubiquitous
> type-tag "pattern" (282 events). Full study: [`SAG-LEARNINGS.md`](./SAG-LEARNINGS.md).
>
> **The gap it fills:** the documented "generic-tag noise" limitation
> ([TOOL-ORCHESTRATION.md](./TOOL-ORCHESTRATION.md) §"Convergence gotchas"):
> flat shared-tag count lets the `pattern` tag (282 cards) crowd out the
> `pi-obsidian` bridge (3 cards) in cross-link ranking. SAG's typed entities
> solve this implicitly (entities ARE the rare specific terms); we solve it
> explicitly via **IDF weighting**.

- **Lever (WRITE side — `ingestRecords`):** when `linkWeighting:"idf"`, compute
  `IDF(tag) = log(N/df)` across the folder and rank cross-link neighbours by
  `Σ IDF(sharedTag)` instead of raw count. Rare specific bridges
  (`pi-obsidian`) get high IDF; ubiquitous type-tags (`pattern`) get ~0. Also
  extract typed entities from each card's detail body deterministically
  (SAG's `localNamedEntities` tier, re-targeted to 8 dev-knowledge types:
  tool/model/config/concept/error/lib/file/tag) and store them as additive
  `entities: [{type,name}]` frontmatter.
- **Lever (READ side — `retrieveRecords`):** the same `linkWeighting:"idf"`
  option lets `knowledge_query` score by `Σ IDF(sharedTag)`, so a query naming
  a specific concept (`pi-obsidian`) retrieves the right card even when dozens
  of unrelated cards share the generic `pattern` tag. This is the P7
  (tag-path recall) fix via a different axis — IDF weighting instead of
  full-text fallback.
- **Effort:** **M.** New `src/entities.ts` (extraction + IDF + scoreOverlap);
  `ingest.ts` + `retrieve.ts` wired with an opt-in `linkWeighting` option.
- **Risk:** **low.** ADDITIVE + OPT-IN: the default `"count"` mode is
  byte-for-byte unchanged (235 pre-existing tests pass; 22 new tests cover the
  IDF path). No semantic blend reopened (P3 stays closed — IDF is a lexical
  weighting, not vectors). No chunking (P5 stays rejected — atomic-zettel
  intact). No LLM at ingest (deterministic extraction only).
- **Proof metric (promotion gate):** run `scripts/real-retrieval-measure.mjs`
  with `linkWeighting:"idf"` vs `"count"` on the 25-query eval set
  (`scripts/real-retrieval-eval.json`). IDF must beat count on **hit-rate@4**
  (current count baseline: 0.48) to justify promoting IDF to the default.
  Until then, IDF ships as an opt-in mechanism (ready to A/B test, no
  regression risk).
- **Verdict:** **✅ SHIPPED (opt-in mechanism).** The integration test proves
  the documented limitation is fixed: a target card sharing `pattern` with 5
  noise cards AND `pi-obsidian` with 1 bridge card links the bridge FIRST under
  IDF (vs alphabetical-noise-first under count). Default stays `"count"` until
  the promotion gate is met.

---

### P9 — Convergence coverage health dimension (kill the silent-failure tax)  ✅ **SHIPPED (engine + surfaces, 2026-07-13)**

> **Origin:** NOT a vault-mind-comparison proposal (P1–P8). Surfaced by running
> experience — the 83%-unconverged incident (43/52 global working-memory entries
> silently never converged; invisible until a manual `/memory-health`). The
> structural `graphHealth` (dead-links/orphans/MOC-drift) cannot see this: it has
> no notion of the EXPECTED source set. P9 adds that dimension.

- **Lever:** a dry-run `coverageReport()` (in `src/ingest.ts`) computes a
  **per-family** id-diff: `missing = E − V` (records that never converged),
  `sourceOrphaned = V − E` (card whose source disappeared). Reuses the REAL
  ingest adapters for E and `readCardMeta` for V (faithful — same code path as
  ingest). Per-family by design (the `pi-memory:`↔`hermes:` id-namespace split
  makes id-diff only meaningful within a family).
- **Surfaces:** additive `GraphHealthResult.coverage?`; `zk.health {coverage:true}`
  host-fn; `zk-query --coverage` CLI (exit 1 on missing). A watch-list
  (`.pi/kcard-coverage.json` + conventional defaults) lets one command check
  every family — the layer that solves the invisible-failure tax.
- **Effort:** M. **Risk:** low (additive, deterministic, no LLM, no schema change).
- **Perf gate (MEASURED 2026-07-13, synthetic, receipt
  `output/kcard-coverage-measurements/`):** wall-clock median 1.6 ms @ N=100,
  **8.0 ms @ N=500** (current vault scale), 16.9 ms @ N=1000 — all ≪ the 1 s gate.
  Reuses the sub-second ingest parsers, as designed.
- **Recall gate (DEFERRED):** the 83% repro requires the REAL vault + real hermes
  source, which needs the primary worktree (the vault submodule is uninitialized
  in dev worktrees). Run after merge: `zk-query --coverage` from the primary
  worktree → `missing[]` must include the entries `/memory-health` flags. The
  mechanism is proven by the faithful-gate unit tests (missing/sourceOrphaned/
  per-family isolation); the real run is the field confirmation.
- **Verdict: ✅ SHIPPED.** Also the **prerequisite ④ (learning feedback loop)
  needs** — `missing[]` IS ④'s ingest worklist.

## 5. Ranking summary

| # | Proposal | Effort | Risk | Priority | Gate metric |
|---|---|---|---|---|---|
| **P3** | Re-confirm semantic-blend measurement | S | low | ✅ CLOSED (retire) | semantic-lexical relevance@4 > lexical+graph +0.05, else retire |
| **P1** | Richer feature metadata in zettel frontmatter | M | low | ✅ CLOSED (dormant) | callout boost NEUTRAL (Δ=0, 0/25 flips); surfacing works (60%); keep dormant, reopen at >15% callout density (receipt real-retrieval-measurements) |
| P4 | Graph-health-aware reindex sync | M | medium | ❌ COLLAPSED (P3 retired) | reopen only if P3 reopens + semantic wins (opt-in) |
| P2 | Change-detection fingerprint | S | low | ⏸ DEFER (scale) | >30% speedup on no-op re-ingest; reopen at ~4000+ cards |
| P6 | Hierarchical-tag flattening | S | low | ❌ DROP (0.4% measured) | reopen if hierarchical-tag rate >5% (measured 2/429) |
| **P7** | knowledge_query NL recall (tag→full-text) | M | low-med | ✅ zk_ask branch CLOSED (live 0.64 ≥ 5; tag-path candidate only) | reopen (tag path) on felt pain; zk_ask branch closed unless a retrieval change drops it <0.5 (re-run `scripts/live-zk-ask-measure.mjs`) |
| **P8** | Typed-entity extraction + IDF-weighted cross-linking (SAG-inspired) | M | low | ✅ SHIPPED (mechanism, opt-in) | IDF must beat count on `scripts/real-retrieval-eval.json` hit-rate@4 before default promotion; default stays "count" |
| **P9** | Convergence coverage health dimension (missing / sourceOrphaned per family) | M | low | ✅ SHIPPED (engine + surfaces) | perf gate PASS (8 ms @ N=500); recall repro deferred to primary worktree (`zk-query --coverage` vs `/memory-health`) |
| P5 | Per-section chunking | — | — | **rejected** | not applicable (atomic-zettel design) |

---

## 6. Next execution cycle — pick-list

The top 1–2 proposals to actually build next, each with its proof metric.

1. **[P3] ✅ DONE — CLOSED (retire, iter-7).**
2. **[P1] ✅ DONE — CLOSED (ship, feature-aware-retrieval cycle).** Additive
   frontmatter keys + bounded callout ranking boost + callout surfacing shipped;
   mechanism proven deterministically (real surface has 0 callouts, so the
   LLM-judge harness was vacuous). Reopen when a callout-bearing surface exists.

*Everything else is **defer** (P2/P4/P6) or **rejected** (P5); **P1** is CLOSED
(dormant, Δ=0 measured); **P7**’s zk_ask branch is CLOSED (live hit-rate@4 =
0.64 ≥ 0.5, receipt `measure-2026-07-08T14-27-04-881Z`) — it survives as a
**tag-path-only candidate** (reopen on felt pain). No `zk_*` / `obsidian_*` code
ships until the plan is reviewed and the real-retrieval eval set is re-run
against any ranking change.*

> **🏁 Knowledge arc closed (2026-07-08).** Every item P1–P7 now has a
> measured/settled verdict — no “candidate with an untested branch” remains:
> **P1** CLOSED-dormant (Δ=0 callout boost, surface-only), **P3** CLOSED-retired
> (semantic blend lost iter-6/7), **P5** rejected (atomic-zettel design), **P6**
> dropped (0.4% hierarchical-tag rate), **P2/P4** deferred-with-conditions, and
> **P7** settled (zk_ask branch CLOSED at 0.64; tag-path candidate only). The
> durable regression assets are `scripts/real-retrieval-eval.json` (the eval
> set) + `scripts/real-retrieval-measure.mjs` (tag-path baseline, 0.48) +
> `scripts/live-zk-ask-measure.mjs` (zk_ask live baseline, 0.64) — re-run either
> against any future retrieval/ranking change to catch regressions. The next
> cycle can pivot (media generation has momentum) with no dangling knowledge
> thread.

---

## 7. Methodology + caveats

- **vault-mind ≠ our stack.** It's FastAPI + ChromaDB + sentence-transformers
  (Python); our extensions are Bun/TS. "Learn from" means *ideas* (parsing,
  chunking, hybrid retrieval), **not** a port. No proposal here rewrites our
  KG in Python.
- **The semantic-blend prior is a warning, not a license.** The 2026-07-05
  receipt (lexical 0.332 vs semantic-lexical 0.100) means embeddings do *not*
  improve our graph-RAG by default. P3 re-confirms before any investment; P4
  is gated behind P3.
- **Atomic-zettel is load-bearing.** P5 (chunking) is rejected *because* the
  one-card-per-record model is the convergence sink's value proposition. Any
  future "let's chunk like vault-mind" urge must re-litigate that design
  decision, not quietly adopt it.
- **No code changed producing this doc.** The only artifact created is the
  throwaway spike under `output/` (never committed to a package).
