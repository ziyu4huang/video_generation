# 05 — FS-style read surface

type: prototype
blocked by: 02 (needs the index to answer ls/tree cheaply)

## Question

OpenViking's identity is the `viking://` virtual FS — agents browse context with `ls/tree/find/grep/stat` instead of querying a black box. Design kcard's equivalent read surface as a **prototype to react to** (cheap, rough, concrete):

- Shape: new tools (`kcard_ls`, `kcard_tree`, `kcard_find`, `kcard_grep`) vs one tool with an `op` param vs folding into `knowledge_query`?
- Each op must return tier-ladder output (L0 summaries by default, L1 on demand) — the existing `renderTier` is the renderer.
- What addresses the ops? Vault-relative card paths already exist; do we need a `kcard://`-style URI or are vault paths the URIs?
- Tool-surface impact: does `zk_ask` get absorbed? Consult the tool-gating contract and hermes's `__piKnowledgePipeline` seam consumers before deciding.
- Deterministic-only, zero LLM tokens per op (consistent with D5/D6).

## Resolution (2026-08-23 — D32–D36; prototype-to-react-to, decisions recorded for reaction)

Grounding (recon this session): `RetrieveResult` consumers = `knowledge_query` (knowledge-card.ts:1120-1138, reads count/scanned/excluded/digest), `zkRetrieve` host-fn (host-fns.ts:85-88; hermes `knowledge_search` inherits via the `__piKnowledgePipeline` seam, HM knowledge-search-tool.ts:138-150), CLI zk-query (zk-query.ts:158-185). `zk_ask` consumes the digest/tier contract via prompts only (task-builders.ts). `HierarchicalCard` carries stem/path/title/kind/score/viaTree/summary — no id/tags/tiers (hierarchical-retrieval.ts:58-69); `buildRetrievedCard` (retrieve.ts:699-746) already hydrates a full `RetrievedCard` from an md path (the missing bridge). `formatDigest` renders any `RetrievedCard` list unchanged. Flat `RetrieveOptions` has NO `type` filter (retrieve.ts:107-187, CI contract :73-77); D18's filter exists only on `HierarchicalOptions.type`. `zk_card` is the one-tool-many-actions precedent (action StringEnum). obsidian ext's `obsidian_search` is the grep/find UX precedent (matchMode/fields/context).

**D32 — tool shape: ONE new tool `zk_fs` with `op: ls|tree|find|grep|stat`** (zk_card's action-param precedent; 1 gate family + 1 probe set instead of 4 tool schemas — schema-cost discipline). NOT folding into `knowledge_query` (query lane ≠ browse lane; different param spaces).

**D33 — addressing: vault-relative paths ARE the URIs** (obsidian ext precedent; agents already handle them). Virtual type namespace `type/<kind>` is rendered by ls/tree only, never on disk (D15 types-not-folders holds). NO `kcard://` scheme — zero consumers, pure ceremony.

**D34 — `zk_ask` NOT absorbed** (LLM subagent RAG pipeline, orthogonal to the deterministic browse surface; D5/D6). `knowledge_query` stays the query lane and GAINS the D18 `type` param; hermes `knowledge_search` inherits everything via the seam unchanged.

**D35 — tier contract: every op renders L0 by default, `tier: abstract|overview|full` param promotes** (mirrors knowledge_query's existing param); `renderTier` stays the sole renderer (demote-not-truncate holds). ops are deterministic, zero LLM tokens.

**D36 — D27 default switch flips INSIDE `retrieveRecords`** (single point; knowledge_query + zk.retrieve host-fn + hermes knowledge_search + CLI all inherit): when `semantic && queryText` (and not `hier:false`, not `KCARD_HIER_DEFAULT=0`) → `hierarchicalRetrieve` first; its leaf cards HYDRATE through the flat md-read path (`buildRetrievedCard`) so the `RetrieveResult`/digest/tier contract is preserved byte-shape; `ok:false` / zero hydrated → existing flat path unchanged. `RetrieveOptions` gains `type?: string` (D18 flat-side completion — frontmatter filter in the flat scan, `kind` filter in hier) and `hier?: boolean` (explicit off-switch). Index gains a plain `card_kind` index def (applies on next natural rebuild; correctness never depends on it).

## Build result (2026-08-23 — CLOSED)

Shipped (kcard 572/572 + typecheck; tool-gate 442/442; core-interface 56/56; hermes-memory 1553/1553; perf-harness budgets green):

- **`src/fs-surface.ts`** — D32–D35 ops (`fsLs`/`fsTree`/`fsFind`/`fsGrep`/`fsStat`): tier-ladder rendered (renderTier sole renderer, L0 default + `tier` promote), virtual `type/<kind>` dirs (D15/D18), vault-relative paths as URIs (D33), index-first with md fallback (D2; md lane mirrors the index lane's parent normalization + 子節點 inversion).
- **`zk_fs` tool** (extensions/knowledge-card.ts) — one-tool-many-actions, `zk_fs` gate family + probes + tool-gate corpus entries; `knowledge_query` + `zk.retrieve` gain the `type` param (D18 threading).
- **D27/D36 default switch** (src/retrieve.ts) — hier-first INSIDE `retrieveRecords` (all four consumers inherit: knowledge_query, zk.retrieve host-fn + workflow `zk.retrieve` with semantic default-on, CLI zk-query; hermes `knowledge_search` stays flat — it never passes `semantic:true`): leaf cards hydrate through `buildRetrievedCard` so the `RetrieveResult`/digest/tier contract is shape-preserved; ANY hier failure falls to the unchanged flat path; escape hatches `hier:false` + `KCARD_HIER_DEFAULT=0`. **Freshness gate (reviewer F1/F5)**: the lane serves only when md count === index cardCount AND index embed_model === the resolved model — a stale index falls back to flat, never blind.
- **`RetrieveOptions.type`** on the kcard type + the CI seam contract; `card_kind` plain index def (next natural rebuild).
- **Budgets re-measured**: kcard 5 tools 2711 tok (max 2982); cross-ext grand total 11 tools 4645 tok (max 5110).

**D14 A/B evidence (2026-08-23, live battery, LM Studio bge-m3 + SurrealDB up):**
- A-side (ticket 09 recorded baselines): flat 17/20 hit@5 MRR 0.688; direct hier 17/20 0.700.
- B-side (the switch): `kcard` arm through `retrieveRecords` = **17/20 hit@5, hit@1 12/20, MRR 0.725** (receipts `output/recall-audit/receipt-ticket05-switch-kcard-arm.json` + `-postreview.json`, identical pre/post review); flat escape hatch `KCARD_HIER_DEFAULT=0` reproduces the baseline EXACTLY (`receipt-ticket05-flat-escape.json`). Trace `source: "hierarchical"` + `hierUsed: true` live-confirmed (seed pool 1871).
- **Independent reviewer: verdict FIX-FIRST → all findings fixed in-session.** F1 (CONFIRMED, highest): no freshness gate + no production rebuild path → the freshness gate landed (count+model; in-place-edit staleness stays bounded fog — fold-back below). F2: fsTree md lane rendered roots only → parent normalization + 子節點 inversion + chain test. F3: pre-existing semantic unit tests hit live Surreal → `_testEmbedder && !_hierClient` never attempts hier. F4/F6: inert bodyMatch/slugDom + redefined scanned/excluded on the hier lane → `hierUsed` trace marker + docstrings. F5: embed-model drift → gate checks it. F7: viaTree doc overload → fixed. Nits fixed: type-dir regex, ls root sorting, limit description, budget decomposition. Left as-noted: flat type-filter `scanned` counting (consistent with the existing overlap filters).

**Fold-backs recorded (not blockers):** (1) index rebuild AUTOMATION — no production path calls `rebuildCardIndex` yet (only the eval script); until it exists the switch degrades to flat after any ingest (correct, never stale — but hier is then idle until a rebuild); (2) in-place card EDITS keep counts stable and can rank stale FTS text until the next rebuild; (3) full-scale 06 extraction A/B (already the standing fold-back).
