# SAG Learnings — Distill Knowledge-Graph Usage

> **Source:** `../SAG/` (Zleap-AI/SAG) — a graph-retrieval RAG workbench.
> Paper: [arxiv.org/abs/2606.15971](https://arxiv.org/abs/2606.15971)
> Studied: 2026-07-11. Implementable findings shipped as **P8** (typed-entity +
> IDF-weighted cross-linking). This is the *distill* companion to
> `kg-improvement-plan.md` (the *retrieval* arc).

## SAG's core architecture in one paragraph

SAG distills each document chunk into **ONE fused event** + **MULTIPLE typed
entities** (person / product / concept / metric / …), each with a role
description. The entity-event bipartite graph then drives **multi-hop
retrieval**: query → entities → events → more entities → more events. On
HotpotQA / 2WikiMultiHop / MuSiQue, this beats HippoRAG 2 by +11.16pp
Recall@2 (68.14% → 79.30%) under the same embedding + LLM config — because the
**structure** (typed entities as specific index nodes) bridges concepts that
pure vector similarity misses.

```
chunk ──→ event (ONE fused semantic unit)
chunk ──→ entities (MULTIPLE typed nodes)
event ←→ entities (typed edges, role descriptions)
```

## What we adopted (and why)

### ✅ P8 — Typed-entity extraction + IDF-weighted cross-linking

**The SAG insight that maps to our limitation:** SAG's entities are *specific
and content-grounded* — a query for "flux2" matches the *entity* flux2 (3
events), not the ubiquitous type-tag "pattern" (282 events). This is exactly
the **generic-tag noise** problem our convergence folder suffers
([TOOL-ORCHESTRATION.md](./TOOL-ORCHESTRATION.md) §"Convergence gotchas"): flat
shared-tag count lets `pattern` crowd out the `pi-obsidian` bridge.

**What shipped** (`src/entities.ts` + `ingest.ts` + `retrieve.ts`):

| Component | SAG analogue | Our implementation |
|---|---|---|
| Entity extraction | `localNamedEntities` (deterministic fallback tier) | `extractEntities()` — 5 deterministic passes: backtick code, title-case, hyphenated slugs, quoted concepts, CJK suffixes |
| Entity taxonomy | 11 types (person/org/location/time/product/metric/action/work/group/subject/tags) | 8 types re-targeted to dev-knowledge: **tool/model/config/concept/error/lib/file/tag** |
| Typed edges | entity-event bipartite with role descriptions | Additive `entities: [{type,name}]` frontmatter (no role descriptions — deterministic tier; the card body IS the context) |
| Multi-hop ranking | entity-frequency-weighted expansion | **IDF**: `Σ log(N/df)` over shared tags — rare specific bridges outrank ubiquitous type-tags |

**Why it's opt-in (`linkWeighting:"idf"`), not default:** the lexical+graph
ranking was **MEASURED and pinned** (iter-7: mean rel 0.770). The kg-improvement-
plan's standing rule is that any ranking change needs its own retrieval-quality
run before shipping. P8 ships the *mechanism* + the *measurement hook*
(`linkWeighting` option) so IDF can be A/B-tested against the count baseline on
the existing eval set (`scripts/real-retrieval-eval.json`) before promotion to
default. The default ("count") is byte-for-byte unchanged — verified by 235
pre-existing tests + 22 new tests.

### Proof that IDF fixes the documented limitation

The integration test (`entities.test.ts > "IDF weighting lets rare bridges
outrank ubiquitous type-tags"`) constructs the exact scenario from
TOOL-ORCHESTRATION.md: a target card shares `pattern` with 5 noise cards AND
`pi-obsidian` with 1 bridge card. Under "count", all 6 neighbours tie (shared=1)
and alphabetical tiebreak puts noise first. Under "idf", the bridge ranks FIRST
because `pi-obsidian` (1/7 cards, IDF ≈ 1.95) dominates `pattern` (6/7 cards,
IDF ≈ 0.15).

## What we rejected (and why)

| SAG mechanism | Why we don't adopt | Plan ref |
|---|---|---|
| **LLM-backed event extraction** (`extractEventsFromChunk`) | `zk_ingest` is deterministic-by-design; the LLM distill path is `zk_extract` / `obsidian_distill`. We ported SAG's *deterministic fallback tier* (`localNamedEntities`), not its LLM tier. | P5 (atomic-zettel) |
| **Embeddings** (event title/content, entity name, relation — 4 vectors) | **RETIRED** by measurement. Semantic blend lost iter-6 (0.332 vs 0.100) + iter-7 (0.770 vs 0.466). Graph edges are our structure signal. | P3 (closed-retired) |
| **Per-section chunking** (`chunkMarkdown`, heading_strict / token modes) | Our atomic-zettel model is **one-card-per-record** — chunking would fragment the wiki-link edge graph, and the graph IS our structure. | P5 (rejected) |
| **PostgreSQL + pgvector + BM25 full-text** | We are Bun/TS with markdown-on-disk; the graph is in-memory tag-set intersection. No DB. | §methodology |
| **Fast/Standard dual retrieval modes** (BM25 entity match vs LLM entity extraction) | We already have the split: `knowledge_query` (deterministic tag-path) vs `zk_ask` (LLM graph-RAG). SAG's "fast" mode (BM25 over entities) is the spirit of P8's IDF weighting. | P7 |
| **Rerank model** (qwen3-rerank / LLM rerank) | `zk_ask` already uses an LLM subagent for final answer synthesis; a separate rerank stage would add latency without a measured gap. | — |

## The distilled design principles SAG confirms

1. **Specific beats ubiquitous.** Whether it's SAG's typed entities or our
   IDF-weighted tags, the retrieval win comes from *specific* index nodes
   outranking *generic* ones. This is the single most transferable lesson.

2. **Structure > stuffing.** SAG's paper title: "instead of stuffing more
   chunks into the model, it organizes document knowledge with a lighter
   structure." Our atomic-zettel + cross-link graph is the same philosophy —
   one canonical card per concept, linked, not duplicated.

3. **The bipartite graph is the multi-hop enabler.** SAG's entity↔event edges
   let retrieval start from a matched event and continue through multi-hop
   recall. Our `zk_ask` does this via wiki-link graph expansion
   (`graph:neighbors`) — the mechanism is isomorphic, the node type differs
   (cards vs events, tags vs entities).

4. **Deterministic fallback is valuable.** SAG ships a full `local*` fallback
   for every LLM operation (named entities, event extraction, rerank) so the
   system works without API keys. Our `extractEntities()` is the same design:
   deterministic entity extraction that needs no LLM, ready to be upgraded to
   LLM-backed if a future measurement shows a gap.
